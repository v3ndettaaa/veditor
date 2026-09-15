/**
 * Page-level document surgery: insert, duplicate, delete, reorder and rotate.
 *
 * A page operation touches two things at once: the PDF bytes (via pdf-lib) and
 * the page-index-keyed records that live beside them in the DocumentSession
 * (annotations, layers, user rotations, bookmarks). Both halves are expressed
 * here as explicit transformations over a `PageSnapshot`, which is what makes
 * the whole class of operations undoable with one command: a snapshot of the
 * bytes plus those records is the complete state any page op can change.
 *
 * Deliberately free of `store` and `main` imports so it can be unit-tested
 * without a DOM; the only outward signal is `onPageStructureChanged`, which
 * main.ts uses to reload the pdf engine and re-lay-out.
 */

import { PDFDocument } from 'pdf-lib';
import {
  Annotation,
  DocumentSession,
  Layer,
  PageInfo,
  PDFBookmarkItem
} from './types';

/** old page index -> new page index. Absent = the page was removed. */
export type PageIndexMap = Map<number, number>;

/** Everything a page operation can change, in a form that can be restored. */
export interface PageSnapshot {
  bytes: Uint8Array | undefined;
  pages: PageInfo[];
  pageCount: number;
  annotations: Record<number, Annotation[]>;
  layers: Record<number, Layer[]>;
  rotations: Record<number, number>;
  bookmarks: PDFBookmarkItem[];
  activePageIndex: number;
}

export interface PageBytesResult {
  bytes: Uint8Array;
  pages: PageInfo[];
  pageCount: number;
}

// ---------------------------------------------------------------------------
// Structure-changed signal
// ---------------------------------------------------------------------------

type StructureListener = (doc: DocumentSession) => void;
const structureListeners = new Set<StructureListener>();

/** main.ts subscribes so a page op reloads the engine and re-lays-out. */
export function onPageStructureChanged(listener: StructureListener): () => void {
  structureListeners.add(listener);
  return () => structureListeners.delete(listener);
}

function emitStructureChanged(doc: DocumentSession): void {
  for (const listener of structureListeners) {
    try {
      listener(doc);
    } catch (err) {
      console.error('Page structure listener failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Bytes-level operations
// ---------------------------------------------------------------------------

/**
 * Page geometry as PDF.js would report it: `getSize()` is the unrotated media
 * box, so a quarter-turned page swaps the two axes.
 */
function readPageInfo(doc: PDFDocument): PageInfo[] {
  return doc.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    const rotation = ((Math.round(page.getRotation().angle) % 360) + 360) % 360;
    const swapped = rotation === 90 || rotation === 270;
    const w = swapped ? height : width;
    const h = swapped ? width : height;
    return {
      pageIndex: index,
      pageNumber: index + 1,
      width: w,
      height: h,
      originalWidth: w,
      originalHeight: h,
      rotation
    };
  });
}

/** Encrypted files are common enough that refusing to load them is worse than
 *  operating on their (unencrypted) page tree. */
function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

async function finish(doc: PDFDocument): Promise<PageBytesResult> {
  const bytes = await doc.save();
  // pdf-lib caches `getPages()`, so a document that just had pages removed
  // still reports the old page list. Reading the metadata from a reload of
  // the saved bytes always reflects the true structure.
  const reloaded = await loadDoc(bytes);
  const pages = readPageInfo(reloaded);
  return { bytes, pages, pageCount: pages.length };
}

/** Extracts `indices` into a standalone PDF (the page clipboard's payload). */
export async function exportPdfPages(
  bytes: Uint8Array,
  indices: number[]
): Promise<PageBytesResult | null> {
  const ordered = [...new Set(indices)].filter(i => i >= 0).sort((a, b) => a - b);
  if (ordered.length === 0) return null;

  const source = await loadDoc(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, ordered);
  for (const page of copied) out.addPage(page);
  return finish(out);
}

/** Inserts every page of `insert` starting at `atIndex`. */
export async function insertPdfPages(
  bytes: Uint8Array,
  atIndex: number,
  insert: Uint8Array
): Promise<PageBytesResult> {
  const target = await loadDoc(bytes);
  const source = await loadDoc(insert);
  const copied = await target.copyPages(source, source.getPageIndices());
  const at = clampIndex(atIndex, target.getPageCount(), { allowEnd: true });
  copied.forEach((page, i) => target.insertPage(at + i, page));
  return finish(target);
}

/** Builds a blank page of the given point size. */
export async function createBlankPdf(
  width: number,
  height: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([Math.max(1, width), Math.max(1, height)]);
  return doc.save();
}

/** Inserts `count` blank pages starting at `atIndex`. */
export async function insertBlankPages(
  bytes: Uint8Array,
  atIndex: number,
  count: number,
  width: number,
  height: number
): Promise<PageBytesResult> {
  const blank = await PDFDocument.create();
  for (let i = 0; i < Math.max(1, count); i++) {
    blank.addPage([Math.max(1, width), Math.max(1, height)]);
  }
  return insertPdfPages(bytes, atIndex, await blank.save());
}

/**
 * Removes pages by index. A document cannot lose its last page, so the final
 * remaining index is kept.
 */
export async function deletePdfPages(
  bytes: Uint8Array,
  indices: number[]
): Promise<PageBytesResult> {
  const doc = await loadDoc(bytes);
  const doomed = [...new Set(indices)]
    .filter(i => i >= 0 && i < doc.getPageCount())
    .sort((a, b) => b - a);
  for (const index of doomed) {
    if (doc.getPageCount() <= 1) break;
    doc.removePage(index);
  }
  return finish(doc);
}

/**
 * Moves `indices` so they land immediately before whatever currently sits at
 * `toIndex` (counted in the pre-move document). Pages are re-copied rather than
 * reordered in place because pdf-lib exposes no page-tree reorder; copying only
 * the moved pages keeps the rest of the file byte-identical.
 */
export async function movePdfPages(
  bytes: Uint8Array,
  indices: number[],
  toIndex: number
): Promise<PageBytesResult> {
  const doc = await loadDoc(bytes);
  const total = doc.getPageCount();
  const from = [...new Set(indices)]
    .filter(i => i >= 0 && i < total)
    .sort((a, b) => a - b);
  if (from.length === 0 || from.length === total) return finish(doc);

  const dest = clampIndex(toIndex, total, { allowEnd: true });
  const removedBefore = from.filter(i => i < dest).length;
  const finalDest = Math.max(0, Math.min(total - from.length, dest - removedBefore));

  const extracted = await exportPdfPages(bytes, from);
  if (!extracted) return finish(doc);
  const scratch = await loadDoc(extracted.bytes);
  const copied = await doc.copyPages(scratch, scratch.getPageIndices());

  for (let i = from.length - 1; i >= 0; i--) doc.removePage(from[i]);
  copied.forEach((page, i) => doc.insertPage(finalDest + i, page));
  return finish(doc);
}

function clampIndex(index: number, pageCount: number, opts?: { allowEnd?: boolean }): number {
  const max = opts?.allowEnd ? pageCount : Math.max(0, pageCount - 1);
  return Math.max(0, Math.min(max, Math.floor(index) || 0));
}

// ---------------------------------------------------------------------------
// Index remapping of the session records
// ---------------------------------------------------------------------------

/** Anything still carries a `pageIndex` field gets it rewritten. */
function retarget<T>(item: T, pageIndex: number): T {
  if (item && typeof item === 'object' && 'pageIndex' in (item as Record<string, unknown>)) {
    return { ...(item as Record<string, unknown>), pageIndex } as unknown as T;
  }
  return item;
}

/** Re-keys `pageIndex -> T[]` records through a page map, dropping removed pages. */
export function remapPageRecord<T>(
  records: Record<number, T[]>,
  map: PageIndexMap
): Record<number, T[]> {
  const next: Record<number, T[]> = {};
  for (const key of Object.keys(records)) {
    const oldIndex = Number(key);
    const target = map.get(oldIndex);
    if (target === undefined) continue;
    const list = records[oldIndex];
    if (!list || list.length === 0) continue;
    next[target] = list.map(item => retarget(item, target));
  }
  return next;
}

/** Re-keys `pageIndex -> degrees`, dropping removed pages. */
export function remapRotations(
  rotations: Record<number, number>,
  map: PageIndexMap
): Record<number, number> {
  const next: Record<number, number> = {};
  for (const key of Object.keys(rotations)) {
    const oldIndex = Number(key);
    const target = map.get(oldIndex);
    if (target === undefined) continue;
    const value = rotations[oldIndex];
    if (!value) continue;
    next[target] = value;
  }
  return next;
}

/**
 * Re-keys bookmarks (and their children). A bookmark whose own page is gone is
 * kept only if it still has descendants to hold together — an outline is a
 * tree, and deleting the parent's page should not delete its children's
 * entries too.
 */
export function remapBookmarks(
  bookmarks: PDFBookmarkItem[],
  map: PageIndexMap
): PDFBookmarkItem[] {
  if (!bookmarks?.length) return [];
  const out: PDFBookmarkItem[] = [];
  for (const bookmark of bookmarks) {
    const remapped: PDFBookmarkItem = { ...bookmark };
    const children = bookmark.items?.length ? remapBookmarks(bookmark.items, map) : [];

    if (typeof bookmark.pageIndex === 'number') {
      const target = map.get(bookmark.pageIndex);
      if (target === undefined) delete remapped.pageIndex;
      else remapped.pageIndex = target;
    }
    if (children.length > 0) remapped.items = children;
    else delete remapped.items;

    // Neither an anchor nor descendants: nothing left to show.
    if (remapped.pageIndex === undefined && children.length === 0) continue;
    out.push(remapped);
  }
  return out;
}

/**
 * Builds the old -> new index map for one operation. `order` is the surviving
 * page indices in their final order; anything not listed is dropped.
 */
export function buildIndexMap(order: number[]): PageIndexMap {
  const map: PageIndexMap = new Map();
  order.forEach((oldIndex, newIndex) => map.set(oldIndex, newIndex));
  return map;
}

/** Old indices in their post-move order (for drag-reorder of thumbnails). */
export function reorderIndexMap(
  pageCount: number,
  indices: number[],
  toIndex: number
): PageIndexMap {
  const moving = [...new Set(indices)].filter(i => i >= 0 && i < pageCount).sort((a, b) => a - b);
  if (moving.length === 0) return buildIndexMap([...Array(pageCount).keys()]);

  const moved = new Set(moving);
  const rest: number[] = [];
  for (let i = 0; i < pageCount; i++) if (!moved.has(i)) rest.push(i);

  const dest = Math.max(0, Math.min(rest.length, toIndex - moving.filter(i => i < toIndex).length));
  const order = [
    ...rest.slice(0, dest),
    ...moving,
    ...rest.slice(dest)
  ];
  return buildIndexMap(order);
}

/**
 * Index map for pages added to a document. `ops[].at` is an insertion point in
 * the pre-insert index space (0..pageCount), so existing pages shift down by
 * however many pages were spliced in at or before them.
 */
export function spliceIndexMap(
  pageCount: number,
  ops: Array<{ at: number; count: number }>
): PageIndexMap {
  const sorted = ops.filter(op => op.count > 0).slice().sort((a, b) => a.at - b.at);
  const map: PageIndexMap = new Map();
  let shift = 0;
  let next = 0;
  for (let old = 0; old <= pageCount; old++) {
    while (next < sorted.length && sorted[next].at <= old) {
      shift += sorted[next].count;
      next++;
    }
    if (old < pageCount) map.set(old, old + shift);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* falls through to the JSON path for exotic values */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function capturePageSnapshot(
  doc: DocumentSession,
  rotations: Record<number, number>,
  opts?: { omitBytes?: boolean }
): PageSnapshot {
  return {
    // Aliased, not copied: the document's bytes are only ever *replaced*
    // (`applyPageBytesResult`, `save.ts`, the notebook rebuild), never mutated
    // in place, and `pdfEngine.loadFromBytes` slices before handing a buffer to
    // the PDF.js worker — so nobody can detach or scribble on this one. Copying
    // here would cost a full document-sized allocation per snapshot, twice per
    // page op, for up to 150 undo levels.
    bytes: !opts?.omitBytes ? doc.fileData : undefined,
    pages: doc.pages.map(p => ({ ...p })),
    pageCount: doc.pageCount,
    annotations: clone(doc.annotations ?? {}),
    layers: clone(doc.layers ?? {}),
    rotations: { ...rotations },
    bookmarks: clone(doc.bookmarks ?? []),
    activePageIndex: doc.activePageIndex
  };
}

/** Writes a snapshot back onto the document, replacing in place so the many
 *  places holding a reference to `doc` (tabs, engine, panels) stay valid. */
export function applyPageSnapshot(
  doc: DocumentSession,
  rotations: Record<number, number>,
  snapshot: PageSnapshot
): void {
  if (snapshot.bytes !== undefined) doc.fileData = new Uint8Array(snapshot.bytes);
  doc.pages = snapshot.pages.map(p => ({ ...p }));
  doc.pageCount = snapshot.pageCount;
  doc.annotations = clone(snapshot.annotations);
  doc.layers = clone(snapshot.layers);
  doc.bookmarks = clone(snapshot.bookmarks);
  doc.activePageIndex = Math.max(0, Math.min(snapshot.pageCount - 1, snapshot.activePageIndex));
  doc.lastModifiedAt = Date.now();

  for (const key of Object.keys(rotations)) delete rotations[Number(key)];
  for (const key of Object.keys(snapshot.rotations)) {
    rotations[Number(key)] = snapshot.rotations[Number(key)];
  }
}

/** Remaps every page-index-keyed record map through `map`, dropping removed
 *  pages and clamping the active page. Does not touch the bytes. */
export function applyRecordMap(
  doc: DocumentSession,
  rotations: Record<number, number>,
  map: PageIndexMap
): void {
  doc.annotations = remapPageRecord(doc.annotations ?? {}, map);
  doc.layers = remapPageRecord(doc.layers ?? {}, map);
  doc.bookmarks = remapBookmarks(doc.bookmarks ?? [], map);
  if (doc.activePageIndex >= doc.pageCount) doc.activePageIndex = doc.pageCount - 1;
  if (doc.activePageIndex < 0) doc.activePageIndex = 0;
  doc.lastModifiedAt = Date.now();

  const remappedRotations = remapRotations(rotations, map);
  for (const key of Object.keys(rotations)) delete rotations[Number(key)];
  for (const key of Object.keys(remappedRotations)) {
    rotations[Number(key)] = remappedRotations[Number(key)];
  }
}

/** Applies a bytes-only result (geometry etc.) and remaps the session records. */
export function applyPageBytesResult(
  doc: DocumentSession,
  rotations: Record<number, number>,
  result: PageBytesResult,
  map: PageIndexMap
): void {
  doc.fileData = new Uint8Array(result.bytes);
  doc.pages = result.pages.map(p => ({ ...p }));
  doc.pageCount = result.pageCount;
  applyRecordMap(doc, rotations, map);
}

/** Tells the app the page structure moved so it can reload and re-lay-out. */
export function notifyPageStructureChanged(doc: DocumentSession): void {
  emitStructureChanged(doc);
}

/** Rotates pages in the record layer only — the user rotation is app state,
 *  not the PDF's native /Rotate, and the viewport reads it from here. */
export function rotatePageRecords(
  rotations: Record<number, number>,
  indices: number[],
  deltaDeg: number
): void {
  for (const index of indices) {
    const current = rotations[index] || 0;
    rotations[index] = ((current + deltaDeg) % 360 + 360) % 360;
  }
}
