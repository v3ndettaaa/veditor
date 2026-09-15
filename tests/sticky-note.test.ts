import { describe, it, expect } from 'vitest';
import { selectionManager, transformAnnotation, getAnnotationSelectionBox } from '../src/annotations/selection';
import { stickyNoteTool } from '../src/annotations/tools/sticky-note';
import type { StickyNoteAnnotation } from '../src/core/types';

const note = (): StickyNoteAnnotation => ({
  id: 'n1',
  pageIndex: 0,
  layerId: 'layer-default',
  type: 'sticky-note',
  box: { x: 100, y: 100, width: 180, height: 140 },
  anchor: { x: 100, y: 100 },
  collapsed: false,
  paper: { pattern: 'lined', spacing: 22, lineColor: '#d9c66c', paperColor: '#fef9c3', margin: false },
  ink: [{
    kind: 'pen',
    points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 30, y: 20, pressure: 0.5 }],
    color: '#0f172a',
    strokeWidth: 2
  }],
  texts: [{ text: 'hi', fontFamily: 'Inter', fontSize: 14, color: '#0f172a', x: 5, y: 5, w: 100 }],
  opacity: 1,
  createdAt: 0,
  updatedAt: 0
});

describe('sticky notes', () => {
  it('creates compact collapsed notes with paper + anchor', () => {
    const n = stickyNoteTool.createNote(
      { x: 50, y: 60 }, 0, 'layer-default',
      { pattern: 'grid', spacing: 22, lineColor: '#d9c66c', paperColor: '#fef9c3', margin: false },
      200, 150
    );
    expect(n.type).toBe('sticky-note');
    expect(n.collapsed).toBe(true);
    expect(n.anchor).toEqual({ x: 50, y: 60 });
    expect(n.box).toMatchObject({ x: 50, y: 60, width: 200, height: 150 });
    expect(n.ink).toEqual([]);
  });

  it('moves anchor with the box, keeps local ink on pure moves', () => {
    const next = transformAnnotation(note(), { dx: 10, dy: 20, scaleX: 1, scaleY: 1, originX: 100, originY: 100 });
    expect(next.box).toMatchObject({ x: 110, y: 120 });
    expect(next.anchor).toMatchObject({ x: 110, y: 120 });
    expect(next.ink[0].points[0]).toMatchObject({ x: 10, y: 10 });
    expect(next.texts[0]).toMatchObject({ x: 5, y: 5 });
  });

  it('scales anchor + local ink/texts on resize', () => {
    const next = transformAnnotation(note(), { dx: 0, dy: 0, scaleX: 2, scaleY: 2, originX: 100, originY: 100 });
    expect(next.box).toMatchObject({ x: 100, y: 100, width: 360, height: 280 });
    expect(next.anchor).toMatchObject({ x: 100, y: 100 });
    expect(next.ink[0].points[0]).toMatchObject({ x: 20, y: 20 });
    expect(next.ink[0].strokeWidth).toBe(4);
    expect(next.texts[0]).toMatchObject({ x: 10, y: 10, fontSize: 28 });
  });

  it('hit-tests collapsed pins at the anchor', () => {
    const collapsed = { ...note(), collapsed: true };
    expect(selectionManager.findAnnotationAtPoint({ x: 100, y: 100 }, [collapsed])?.id).toBe('n1');
    expect(selectionManager.findAnnotationAtPoint({ x: 400, y: 400 }, [collapsed])).toBeNull();
  });

  it('hit-tests expanded cards by box', () => {
    const n = note();
    expect(selectionManager.findAnnotationAtPoint({ x: 150, y: 150 }, [n])?.id).toBe('n1');
    expect(selectionManager.findAnnotationAtPoint({ x: 10, y: 10 }, [n])).toBeNull();
  });

  it('selects icon badge when collapsed and full card box when expanded', () => {
    const n = note();
    n.collapsed = true;
    const selBox = getAnnotationSelectionBox(n);
    // Anchor is { x: 100, y: 100 }
    expect(selBox.width).toBe(26);
    expect(selBox.height).toBe(26);
    expect(selBox.x).toBe(100 - 13);
    expect(selBox.y).toBe(100 - 13);

    n.collapsed = false;
    const expandedBox = getAnnotationSelectionBox(n);
    expect(expandedBox.width).toBe(180);
    expect(expandedBox.height).toBe(140);
    expect(expandedBox.x).toBe(100);
    expect(expandedBox.y).toBe(100);
  });
});
