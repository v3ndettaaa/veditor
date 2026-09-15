/**
 * The action layer for page operations: turns a thumbnail-list command
 * (delete, cut, copy, paste, duplicate, reorder, rotate, insert blank) into
 * bytes and record mutations, wraps each one in a single undoable
 * `PageOpsCommand`, and keeps the store's page selection coherent.
 *
 * Everything that changes the document goes through `runMutation`, which is
 * the only place that knows the before/after snapshot dance.
 */

import { history, PageOpsCommand } from './history';
import { notebookController } from './notebook';
import {
  applyPageBytesResult,
  applyRecordMap,
  buildIndexMap,
  capturePageSnapshot,
  deletePdfPages,
  exportPdfPages,
  insertBlankPages,
  insertPdfPages,
  movePdfPages,
  notifyPageStructureChanged,
  reorderIndexMap,
  rotatePageRecords,
  spliceIndexMap
} from './page-ops';
import { store } from './store';
import { DocumentSession, PageClipboard } from './types';

export type PagePasteMode = 'before' | 'after';

class PageActions {
  /** Page ops are async; a second click must not interleave with the first. */
  private _busy = false;

  public get isBusy(): boolean {
    return this._busy;
  }

  // -------------------------------------------------------------------------
  // Clipboard
  // -------------------------------------------------------------------------

  /** True when pasting into the active document is meaningful. */
  public canPaste(mode: PagePasteMode, atIndex = -1): boolean {
    const doc = store.activeDocument;
    const clip = store.pageClipboard;
    if (!doc || !clip) return false;
    // A notebook's bytes are derived from its spec, so foreign pages cannot be
    // spliced in without breaking that invariant.
    if (doc.notebook) return false;
    if (mode === 'after' && atIndex >= doc.pageCount) return false;
    return true;
  }

  public async copyPages(indices: number[]): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc?.fileData) return false;
    const list = this.normalize(indices);
    if (list.length === 0) return false;

    const clip = await this.buildClipboard(doc, list);
    if (!clip) return false;
    store.setPageClipboard(clip);
    return true;
  }

  /** Copy then delete, as one undo step for the destructive half. */
  public async cutPages(indices: number[]): Promise<boolean> {
    const copied = await this.copyPages(indices);
    if (!copied) return false;
    return this.deletePages(indices);
  }

  private async buildClipboard(doc: DocumentSession, indices: number[]): Promise<PageClipboard | null> {
    if (!doc.fileData) return null;
    try {
      const result = await exportPdfPages(doc.fileData, indices);
      if (!result || result.pageCount === 0) return null;
      const first = result.pages[0];
      return {
        bytes: result.bytes,
        pageCount: result.pageCount,
        width: first?.width ?? 612,
        height: first?.height ?? 792,
        sourceName: doc.name
      };
    } catch (err) {
      console.error('Could not copy pages:', err);
      return null;
    }
  }

  /** Pasting into a notebook degrades to blank pages of the same count. */
  public async pastePages(atIndex: number, mode: PagePasteMode): Promise<boolean> {
    const doc = store.activeDocument;
    const clip = store.pageClipboard;
    if (!doc || !clip) return false;

    const insertAt = mode === 'before' ? atIndex : atIndex + 1;
    if (doc.notebook) return this.insertBlankPages(insertAt, clip.pageCount);

    return this.runMutation(
      clip.pageCount > 1 ? `Paste ${clip.pageCount} pages` : 'Paste page',
      d => !!d.fileData && !d.notebook,
      async d => {
        const map = spliceIndexMap(d.pageCount, [{ at: insertAt, count: clip.pageCount }]);
        const result = await insertPdfPages(d.fileData!, insertAt, clip.bytes);
        applyPageBytesResult(d, store.pageRotations, result, map);
        this.selectRange(insertAt, clip.pageCount);
        return true;
      }
    );
  }

  // -------------------------------------------------------------------------
  // Page structure
  // -------------------------------------------------------------------------

  public async deletePages(indices: number[]): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc) return false;
    const list = this.normalize(indices);
    if (list.length === 0 || list.length >= doc.pageCount) return false;

    const removed = new Set(list);
    const order: number[] = [];
    for (let i = 0; i < doc.pageCount; i++) if (!removed.has(i)) order.push(i);

    if (doc.notebook) {
      return this.runMutation(
        list.length > 1 ? `Delete ${list.length} pages` : 'Delete page',
        d => !!d.notebook,
        async d => {
          const ok = await notebookController.applyPageCount(d.pageCount - list.length);
          if (!ok) return false;
          applyRecordMap(d, store.pageRotations, buildIndexMap(order));
          this.afterStructuralChange(list[0], 1);
          return true;
        }
      );
    }

    return this.runMutation(
      list.length > 1 ? `Delete ${list.length} pages` : 'Delete page',
      d => !!d.fileData && !d.notebook,
      async d => {
        const result = await deletePdfPages(d.fileData!, list);
        applyPageBytesResult(d, store.pageRotations, result, buildIndexMap(order));
        this.afterStructuralChange(list[0], 1);
        return true;
      }
    );
  }

  public async duplicatePages(indices: number[]): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc?.fileData) return false;
    const list = this.normalize(indices);
    if (list.length === 0) return false;

    const insertAt = list[list.length - 1] + 1;
    if (doc.notebook) return this.insertBlankPages(insertAt, list.length);

    const extracted = await this.buildClipboard(doc, list);
    if (!extracted) return false;

    return this.runMutation(
      list.length > 1 ? `Duplicate ${list.length} pages` : 'Duplicate page',
      d => !!d.fileData && !d.notebook,
      async d => {
        const map = spliceIndexMap(d.pageCount, [{ at: insertAt, count: list.length }]);
        const result = await insertPdfPages(d.fileData!, insertAt, extracted.bytes);
        applyPageBytesResult(d, store.pageRotations, result, map);
        this.selectRange(insertAt, list.length);
        return true;
      }
    );
  }

  public async insertBlankPages(atIndex: number, count = 1): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc) return false;
    const at = Math.max(0, Math.min(doc.pageCount, Math.floor(atIndex)));
    if (doc.notebook) {
      return this.runMutation(
        count > 1 ? `Insert ${count} pages` : 'Insert page',
        d => !!d.notebook,
        async d => {
          const oldCount = d.pageCount;
          const ok = await notebookController.applyPageCount(oldCount + count);
          if (!ok) return false;
          applyRecordMap(d, store.pageRotations, spliceIndexMap(oldCount, [{ at, count }]));
          this.selectRange(at, count);
          return true;
        }
      );
    }

    if (!doc.fileData) return false;
    // Match the page the blank is going next to, so mixed-size documents keep
    // a consistent look at the insertion point.
    const neighbour = doc.pages[Math.min(at, doc.pageCount - 1)] ?? doc.pages[0];

    return this.runMutation(
      count > 1 ? `Insert ${count} blank pages` : 'Insert blank page',
      d => !!d.fileData && !d.notebook,
      async d => {
        const map = spliceIndexMap(d.pageCount, [{ at, count }]);
        const result = await insertBlankPages(
          d.fileData!,
          at,
          count,
          neighbour?.originalWidth ?? 612,
          neighbour?.originalHeight ?? 792
        );
        applyPageBytesResult(d, store.pageRotations, result, map);
        this.selectRange(at, count);
        return true;
      }
    );
  }

  public async movePages(indices: number[], toIndex: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc) return false;
    const list = this.normalize(indices);
    if (list.length === 0) return false;

    const order = [...reorderIndexMap(doc.pageCount, list, toIndex).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([old]) => old);

    if (doc.notebook) {
      // Notebook pages are identical paper: the bytes need no change, only the
      // annotations that ride along with them.
      return this.runMutation(
        list.length > 1 ? `Move ${list.length} pages` : 'Move page',
        d => !!d.notebook,
        async d => {
          applyRecordMap(d, store.pageRotations, buildIndexMap(order));
          this.afterStructuralChange(order.indexOf(list[0]), list.length);
          return true;
        }
      );
    }

    if (!doc.fileData) return false;
    return this.runMutation(
      list.length > 1 ? `Move ${list.length} pages` : 'Move page',
      d => !!d.fileData && !d.notebook,
      async d => {
        const result = await movePdfPages(d.fileData!, list, toIndex);
        applyPageBytesResult(d, store.pageRotations, result, buildIndexMap(order));
        this.afterStructuralChange(order.indexOf(list[0]), list.length);
        return true;
      }
    );
  }

  /**
   * User rotation lives in the store's rotation record, not the PDF's native
   * /Rotate, so this only touches that record — and therefore needs no byte
   * snapshot.
   */
  public async rotatePages(indices: number[], deltaDeg: number): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc) return false;
    const list = this.normalize(indices);
    if (list.length === 0) return false;

    const rotations = store.pageRotations;
    const before = capturePageSnapshot(doc, rotations, { omitBytes: true });
    rotatePageRecords(rotations, list, deltaDeg);
    const after = capturePageSnapshot(doc, rotations, { omitBytes: true });

    history.pushCommitted(new PageOpsCommand(
      deltaDeg >= 0
        ? (list.length > 1 ? `Rotate ${list.length} pages` : 'Rotate page')
        : (list.length > 1 ? `Rotate ${list.length} pages back` : 'Rotate page back'),
      before,
      after
    ));
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private normalize(indices: number[]): number[] {
    const doc = store.activeDocument;
    if (!doc) return [];
    return [...new Set(indices)]
      .filter(i => Number.isFinite(i) && i >= 0 && i < doc.pageCount)
      .sort((a, b) => a - b);
  }

  /**
   * Runs a mutating operation between two full snapshots and records it as one
   * undo step. The command is never executed: `run` has already applied its
   * effects by the time the snapshots are taken (hence `pushCommitted`).
   *
   * Both the byte-changing path and the notebook path (where
   * `NotebookController` rewrites the bytes itself) go through here, so undo
   * and the structure signal behave identically for either.
   */
  private async runMutation(
    description: string,
    guard: (doc: DocumentSession) => boolean,
    run: (doc: DocumentSession) => Promise<boolean>
  ): Promise<boolean> {
    const doc = store.activeDocument;
    if (!doc || this._busy || !guard(doc)) return false;

    this._busy = true;
    try {
      const rotations = store.pageRotations;
      const before = capturePageSnapshot(doc, rotations);
      const ok = await run(doc);
      if (!ok) return false;
      const after = capturePageSnapshot(doc, rotations);

      history.pushCommitted(new PageOpsCommand(description, before, after));
      notifyPageStructureChanged(doc);
      return true;
    } catch (err) {
      console.error(`Page operation "${description}" failed:`, err);
      return false;
    } finally {
      this._busy = false;
    }
  }

  /** After a delete/move: land on the nearest page that still exists. */
  private afterStructuralChange(removedAt: number, count: number): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const anchor = removedAt >= 0 && removedAt < doc.pageCount ? removedAt : count;
    const target = Math.max(0, Math.min(doc.pageCount - 1, anchor));
    doc.activePageIndex = target;
    store.setSelectedPageIndices([]);
  }

  private selectRange(from: number, count: number): void {
    const doc = store.activeDocument;
    if (!doc) return;
    const range: number[] = [];
    for (let i = from; i < from + count && i < doc.pageCount; i++) range.push(i);
    doc.activePageIndex = Math.min(doc.pageCount - 1, Math.max(0, from));
    store.setSelectedPageIndices(range);
  }
}

export const pageActions = new PageActions();
