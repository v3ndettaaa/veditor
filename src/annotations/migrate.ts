/**
 * Document migration shims.
 *
 * Every load route (IndexedDB restore, file import, notebook rebuild, sample
 * document) funnels through `store.setActiveDocument()`, which calls in here.
 * A document saved by an older build can therefore never carry annotation
 * types this build cannot render: they would linger invisibly, still respond
 * to hit-testing, and still inflate the saved file.
 */

import { Annotation, DocumentSession } from '../core/types';

/**
 * Annotation types that existed in earlier builds and have since been removed
 * outright (replaced by nothing, or by an equivalent tool).
 */
const REMOVED_ANNOTATION_TYPES = new Set<string>(['laser', 'callout', 'sticky-note']);

/**
 * Drops annotations of retired types from every page. Mutates `doc` in place
 * (the pruning persists with the next save) and returns how many were dropped.
 */
export function pruneUnsupportedAnnotations(doc: DocumentSession | null): number {
  if (!doc || !doc.annotations) return 0;

  let dropped = 0;
  for (const key of Object.keys(doc.annotations)) {
    const pageIndex = parseInt(key, 10);
    const list = doc.annotations[pageIndex];
    if (!Array.isArray(list)) {
      delete doc.annotations[pageIndex];
      continue;
    }
    const kept = list.filter((ann) => {
      const supported = !!ann && !REMOVED_ANNOTATION_TYPES.has((ann as Annotation).type as string);
      if (!supported) dropped++;
      return supported;
    });
    if (kept.length === list.length) continue;
    if (kept.length === 0) delete doc.annotations[pageIndex];
    else doc.annotations[pageIndex] = kept;
  }

  if (dropped > 0) doc.lastModifiedAt = Date.now();
  return dropped;
}
