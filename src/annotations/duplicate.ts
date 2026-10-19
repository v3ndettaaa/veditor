/**
 * Duplicate-selected-annotations helper shared by keyboard shortcut,
 * command palette, and any future toolbar entry.
 * Returns the new annotation ids (empty when nothing was duplicated).
 */

import { store } from '../core/store';
import { history, AddAnnotationCommand } from '../core/history';
import { offsetAnnotation } from './selection';

const OFFSET = 12;

export function duplicateSelectedAnnotations(): string[] {
  const doc = store.activeDocument;
  const selectedIds = Array.from(store.selectedAnnotationIds);
  if (!doc || selectedIds.length === 0) return [];
  const newIds: string[] = [];
  for (const pageIdx in doc.annotations) {
    const pageIndex = parseInt(pageIdx, 10);
    const sel = doc.annotations[pageIndex].filter(a => selectedIds.includes(a.id));
    for (const ann of sel) {
      const copy: any = offsetAnnotation(ann, OFFSET, OFFSET);
      copy.id = Math.random().toString(36).substring(2, 10);
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      history.execute(new AddAnnotationCommand(pageIndex, copy));
      newIds.push(copy.id);
    }
  }
  if (newIds.length > 0) {
    doc.lastModifiedAt = Date.now();
    store.setSelectedAnnotationIds(newIds);
  }
  return newIds;
}
