/**
 * Duplicate-selected-annotations helper shared by keyboard shortcut,
 * command palette, and any future toolbar entry.
 * Returns the new annotation ids (empty when nothing was duplicated).
 */

import { store } from '../core/store';
import { history, AddAnnotationCommand } from '../core/history';
import { cloneAnnotation } from './selection';

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
      const copy: any = cloneAnnotation(ann);
      copy.id = Math.random().toString(36).substring(2, 10);
      copy.box = { ...copy.box, x: copy.box.x + OFFSET, y: copy.box.y + OFFSET };
      const shiftPts = (pts: any[]) => pts.map((p: any) => ({ ...p, x: p.x + OFFSET, y: p.y + OFFSET }));
      if (Array.isArray(copy.points) && copy.points.length > 0 && Array.isArray(copy.points[0])) {
        // Signature strokes: array of point arrays.
        copy.points = (copy.points as any[]).map((stroke: any[]) => shiftPts(stroke));
      } else if (Array.isArray(copy.points)) {
        copy.points = shiftPts(copy.points);
      }
      if (copy.arrowPoint) copy.arrowPoint = { ...copy.arrowPoint, x: copy.arrowPoint.x + OFFSET, y: copy.arrowPoint.y + OFFSET };
      if (copy.type === 'sticky-note') {
        if (copy.anchor) copy.anchor = { ...copy.anchor, x: copy.anchor.x + OFFSET, y: copy.anchor.y + OFFSET };
        // Ink/texts live in note-local coords — they move with the box.
      }
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
