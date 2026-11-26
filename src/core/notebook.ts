/**
 * Notebook lifecycle: rebuilding a generated notebook's bytes when it gains
 * pages or its paper changes.
 *
 * A notebook's PDF is fully derived from its `NotebookSpec` plus its page
 * count, so both operations are the same rebuild. Annotations are keyed by
 * page index in the store and page geometry never changes, so they survive a
 * rebuild untouched -- which is why paper can be restyled after the fact
 * without losing work.
 */

import { store } from './store';
import { pdfEngine } from './pdf-engine';
import { viewportManager } from './viewport';
import {
  NotebookSpec,
  PaperStyle,
  PageSizeName,
  NotebookOrientation,
  NotebookCoverSpec,
  DocumentSession
} from './types';
import { buildNotebookPdf, DEFAULT_PAPER } from '../io/notebook';
import {
  getDefaultNotebookCover,
  hasNotebookCover,
  remapDocumentPagesForCoverToggle
} from '../io/notebook-covers';
import {
  getDocumentSession,
  saveDocumentSession,
  updateRecentThumbnail
} from '../io/storage';

/**
 * Extend when a stroke lands within this much of the bottom of the last page,
 * in page points -- roughly the last two ruled lines.
 */
const AUTO_EXTEND_ZONE = 64;

/** Hard stop, so a runaway loop can't grow a document without bound. */
const MAX_PAGES = 500;

export interface NotebookRestyleOptions {
  paper?: Partial<PaperStyle>;
  pageSize?: PageSizeName;
  orientation?: NotebookOrientation;
  cover?: NotebookCoverSpec | null;
  title?: string;
}

export class NotebookController {
  private _rebuilding = false;
  private _onRebuilt: (() => void) | null = null;

  /** Lets main.ts re-lay-out and repaint after the bytes change. */
  public init(onRebuilt: () => void) {
    this._onRebuilt = onRebuilt;
  }

  public isNotebook(doc: DocumentSession | null = store.activeDocument): boolean {
    return !!doc?.notebook;
  }

  /** The spec for a brand-new notebook. */
  public defaultSpec(): NotebookSpec {
    return {
      paper: { ...DEFAULT_PAPER },
      pageSize: 'letter',
      orientation: 'portrait',
      cover: getDefaultNotebookCover()
    };
  }

  /** Rebuilds the active notebook's bytes for a new paper page count and/or spec. */
  private async rebuild(
    spec: NotebookSpec,
    paperPageCount: number,
    targetDoc: DocumentSession | null = store.activeDocument
  ): Promise<boolean> {
    const doc = targetDoc;
    if (!doc || this._rebuilding) return false;

    this._rebuilding = true;
    try {
      const bytes = await buildNotebookPdf(spec.paper, spec.pageSize, paperPageCount, {
        cover: spec.cover,
        orientation: spec.orientation ?? 'portrait'
      });

      const isActive = store.activeDocument?.id === doc.id;
      const isOpen = store.openDocuments.has(doc.id);

      if (isOpen) {
        // Drop the cached proxy, or loadFromBytes would hand back the stale one
        // for this id instead of parsing the new bytes.
        pdfEngine.unloadDoc(doc.id);
        const meta = await pdfEngine.loadFromBytes(bytes.slice(0), doc.id);
        doc.pageCount = meta.pageCount;
        doc.pages = meta.pages;
      } else {
        doc.pageCount = hasNotebookCover(spec) ? paperPageCount + 1 : paperPageCount;
      }

      doc.fileData = bytes;
      doc.notebook = spec;
      doc.lastModifiedAt = Date.now();

      await saveDocumentSession(doc, { includeBytes: true });
      // Clear stale cached page-1 thumbnail so Library immediately renders the updated cover/paper.
      await updateRecentThumbnail(doc.id, '');

      if (isOpen) {
        store.notify();
      }
      if (isActive) {
        viewportManager.updateLayout(true);
        this._onRebuilt?.();
      }
      return true;
    } finally {
      this._rebuilding = false;
    }
  }

  /**
   * Applies paper, cover, pageSize, orientation, and/or title changes to the open notebook.
   * Safely shifts annotation/layer/bookmark page indices when adding or removing Page 1 cover.
   */
  public async restyle(
    patchOrOpts: Partial<PaperStyle> | NotebookRestyleOptions,
    pageSize?: PageSizeName
  ): Promise<void> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return;

    const opts: NotebookRestyleOptions =
      pageSize !== undefined || 'pattern' in patchOrOpts || 'paperColor' in patchOrOpts || 'spacing' in patchOrOpts
        ? { paper: patchOrOpts as Partial<PaperStyle>, pageSize }
        : (patchOrOpts as NotebookRestyleOptions);

    await this.applyRestyleToSession(doc, opts);
  }

  /**
   * Edits a notebook's cover, paper, title, size, or orientation from the Library
   * (works seamlessly whether the notebook is currently open in a tab or closed in IndexedDB).
   */
  public async restyleStoredNotebook(
    docId: string,
    opts: NotebookRestyleOptions
  ): Promise<boolean> {
    const openDoc = store.openDocuments.get(docId);
    if (openDoc && openDoc.notebook) {
      return this.applyRestyleToSession(openDoc, opts);
    }
    const stored = await getDocumentSession(docId);
    if (!stored || !stored.notebook) return false;
    return this.applyRestyleToSession(stored, opts);
  }

  private async applyRestyleToSession(
    doc: DocumentSession,
    opts: NotebookRestyleOptions
  ): Promise<boolean> {
    if (!doc.notebook) return false;
    const oldSpec = doc.notebook;
    const nextSpec: NotebookSpec = {
      paper: { ...oldSpec.paper, ...(opts.paper ?? {}) },
      pageSize: opts.pageSize ?? oldSpec.pageSize,
      orientation: opts.orientation ?? oldSpec.orientation ?? 'portrait',
      cover: opts.cover !== undefined ? opts.cover : oldSpec.cover
    };

    const hadCover = hasNotebookCover(oldSpec);
    const willHaveCover = hasNotebookCover(nextSpec);
    const remapped = remapDocumentPagesForCoverToggle(
      {
        pageCount: doc.pageCount,
        activePageIndex: doc.activePageIndex,
        annotations: doc.annotations,
        layers: doc.layers,
        userBookmarks: doc.userBookmarks
      },
      hadCover,
      willHaveCover
    );

    doc.annotations = remapped.annotations;
    doc.layers = remapped.layers;
    doc.activePageIndex = remapped.activePageIndex;
    if (remapped.userBookmarks !== undefined) {
      doc.userBookmarks = remapped.userBookmarks;
    }

    if (opts.title && opts.title.trim()) {
      const trimmed = opts.title.trim();
      doc.name = trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`;
    }

    return this.rebuild(nextSpec, remapped.paperPageCount, doc);
  }

  /** Appends blank paper pages. Returns the number actually added. */
  public async addPages(count = 1): Promise<number> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return 0;
    const hasCover = hasNotebookCover(doc.notebook);
    const targetTotal = Math.min(MAX_PAGES, doc.pageCount + count);
    const added = targetTotal - doc.pageCount;
    if (added <= 0) return 0;
    const paperPages = hasCover ? Math.max(1, targetTotal - 1) : targetTotal;
    await this.rebuild(doc.notebook, paperPages, doc);
    return added;
  }

  /**
   * Resizes the notebook to `count` total PDF pages (including cover Page 1 if present).
   * Callers are responsible for remapping page-index-keyed annotations afterwards.
   */
  public async applyPageCount(count: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return false;
    const hasCover = hasNotebookCover(doc.notebook);
    const minTotal = hasCover ? 2 : 1;
    const targetTotal = Math.max(minTotal, Math.min(MAX_PAGES, Math.floor(count)));
    if (targetTotal === doc.pageCount) return false;
    const paperPages = hasCover ? Math.max(1, targetTotal - 1) : targetTotal;
    return this.rebuild(doc.notebook, paperPages, doc);
  }

  public atPageLimit(): boolean {
    return (store.activeDocument?.pageCount ?? 0) >= MAX_PAGES;
  }

  /**
   * Grows the notebook when the user writes near the bottom of its last page,
   * so there is always blank paper below. Call after a stroke commits.
   */
  public async autoExtend(pageIndex: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc?.notebook || this._rebuilding) return false;
    if (pageIndex !== doc.pageCount - 1) return false;
    if (this.atPageLimit()) return false;

    const page = doc.pages[pageIndex];
    if (!page) return false;

    const reach = this.lowestInkOnPage(pageIndex);
    if (reach === null) return false;
    if (reach < page.originalHeight - AUTO_EXTEND_ZONE) return false;

    return (await this.addPages(1)) > 0;
  }

  /** The largest y any annotation on the page reaches, in page units. */
  private lowestInkOnPage(pageIndex: number): number | null {
    const anns = store.activeDocument?.annotations[pageIndex];
    if (!anns?.length) return null;

    let lowest: number | null = null;
    for (const ann of anns) {
      const bottom = ann.box.y + ann.box.height;
      if (lowest === null || bottom > lowest) lowest = bottom;
    }
    return lowest;
  }
}

export const notebookController = new NotebookController();
