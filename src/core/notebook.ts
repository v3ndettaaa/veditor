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
import { NotebookSpec, PaperStyle, PageSizeName, DocumentSession } from './types';
import { buildNotebookPdf, DEFAULT_PAPER } from '../io/notebook';
import { saveDocumentSession } from '../io/storage';

/**
 * Extend when a stroke lands within this much of the bottom of the last page,
 * in page points -- roughly the last two ruled lines.
 */
const AUTO_EXTEND_ZONE = 64;

/** Hard stop, so a runaway loop can't grow a document without bound. */
const MAX_PAGES = 500;

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
    return { paper: { ...DEFAULT_PAPER }, pageSize: 'letter' };
  }

  /** Rebuilds the active notebook's bytes for a new page count and/or paper. */
  private async rebuild(spec: NotebookSpec, pageCount: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc || this._rebuilding) return false;

    this._rebuilding = true;
    try {
      const bytes = await buildNotebookPdf(spec.paper, spec.pageSize, pageCount);

      // Drop the cached proxy, or loadFromBytes would hand back the stale one
      // for this id instead of parsing the new bytes.
      pdfEngine.unloadDoc(doc.id);
      const meta = await pdfEngine.loadFromBytes(bytes.slice(0), doc.id);

      doc.fileData = bytes;
      doc.notebook = spec;
      doc.pageCount = meta.pageCount;
      doc.pages = meta.pages;
      doc.lastModifiedAt = Date.now();

      await saveDocumentSession(doc, { includeBytes: true });

      store.notify();
      viewportManager.updateLayout(true);
      this._onRebuilt?.();
      return true;
    } finally {
      this._rebuilding = false;
    }
  }

  /** Applies a paper change to the open notebook, keeping every page. */
  public async restyle(patch: Partial<PaperStyle>, pageSize?: PageSizeName): Promise<void> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return;
    const spec: NotebookSpec = {
      paper: { ...doc.notebook.paper, ...patch },
      pageSize: pageSize ?? doc.notebook.pageSize
    };
    await this.rebuild(spec, doc.pageCount);
  }

  /** Appends blank pages. Returns the number actually added. */
  public async addPages(count = 1): Promise<number> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return 0;
    const target = Math.min(MAX_PAGES, doc.pageCount + count);
    const added = target - doc.pageCount;
    if (added <= 0) return 0;
    await this.rebuild(doc.notebook, target);
    return added;
  }

  /**
   * Resizes the notebook. Every page is identical ruled paper, so the caller
   * is responsible for remapping the page-index-keyed annotations through the
   * same index map afterwards — this only rewrites the bytes.
   */
  public async applyPageCount(count: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc?.notebook) return false;
    const target = Math.max(1, Math.min(MAX_PAGES, Math.floor(count)));
    if (target === doc.pageCount) return false;
    return this.rebuild(doc.notebook, target);
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
