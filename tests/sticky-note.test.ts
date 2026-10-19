import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { stickyNoteTool, DEFAULT_STICKY_COLORS } from '../src/annotations/tools/sticky-note';
import {
  getAnnotationSelectionBox,
  offsetAnnotation,
  transformAnnotation,
  selectionManager
} from '../src/annotations/selection';
import { syncNativeAnnotations, importNativeAnnotations } from '../src/core/native-annotations';
import { DEFAULT_TOOLBAR_ORDER, StickyNoteAnnotation } from '../src/core/types';

describe('StickyNoteTool & StickyNoteAnnotation', () => {
  const sampleNote: StickyNoteAnnotation = stickyNoteTool.createStickyNote(
    0,
    'layer-default',
    { x: 100, y: 120, width: 220, height: 220 },
    'Review equation 4.2\nand check boundary terms.',
    {
      color: '#fef08a',
      textColor: '#3b2f1e',
      author: 'Kia Gh',
      fontSize: 15,
      textAlign: 'left',
      collapsed: false,
      strokes: [
        {
          id: 'stroke_1',
          color: '#3b2f1e',
          strokeWidth: 2,
          opacity: 1,
          points: [
            { x: 120, y: 180, pressure: 0.5 },
            { x: 160, y: 200, pressure: 0.6 },
            { x: 190, y: 195, pressure: 0.5 }
          ]
        }
      ]
    }
  );

  it('includes sticky-note in toolbar defaults and palette', () => {
    expect(DEFAULT_TOOLBAR_ORDER).toContain('sticky-note');
    expect(DEFAULT_STICKY_COLORS.length).toBeGreaterThanOrEqual(6);
  });

  it('creates a well-formed StickyNoteAnnotation with minimum card bounds', () => {
    const small = stickyNoteTool.createStickyNote(
      0,
      'layer-default',
      { x: 40, y: 50, width: 20, height: 20 },
      'Short note'
    );
    expect(small.type).toBe('sticky-note');
    expect(small.box.width).toBeGreaterThanOrEqual(150);
    expect(small.box.height).toBeGreaterThanOrEqual(140);
    expect(small.author).toBe('Kia Gh');
    expect(small.collapsed).toBe(false);
    expect(Array.isArray(small.strokes)).toBe(true);
  });

  it('hit-tests expanded card, collapse button, and content area accurately', () => {
    // Inside card
    expect(stickyNoteTool.hitTest(sampleNote, { x: 150, y: 180 })).toBe(true);
    // Outside card
    expect(stickyNoteTool.hitTest(sampleNote, { x: 50, y: 50 })).toBe(false);

    // Top-right collapse button inside header
    const btnHit = stickyNoteTool.hitTestCollapseButton(sampleNote, {
      x: sampleNote.box.x + sampleNote.box.width - 21,
      y: sampleNote.box.y + 18
    });
    expect(btnHit).toBe(true);

    // Content area vs header area
    expect(stickyNoteTool.isPointInContentArea(sampleNote, { x: 150, y: 180 })).toBe(true);
    expect(stickyNoteTool.isPointInContentArea(sampleNote, { x: 150, y: 130 })).toBe(false);
  });

  it('uses compact folded-corner icon bounds when collapsed', () => {
    const collapsedNote: StickyNoteAnnotation = { ...sampleNote, collapsed: true };
    const iconBox = stickyNoteTool.getCollapsedIconBox(collapsedNote);
    expect(iconBox).toEqual({ x: 100, y: 120, width: 38, height: 38, rotation: 0 });
    expect(getAnnotationSelectionBox(collapsedNote)).toEqual(iconBox);

    // Point inside 38x38 icon hits
    expect(stickyNoteTool.hitTest(collapsedNote, { x: 118, y: 138 })).toBe(true);
    // Point inside full 220x220 box but outside 38x38 icon misses when collapsed
    expect(stickyNoteTool.hitTest(collapsedNote, { x: 250, y: 250 })).toBe(false);
    expect(selectionManager.findAnnotationAtPoint({ x: 250, y: 250 }, [collapsedNote])).toBeNull();
    expect(selectionManager.findAnnotationAtPoint({ x: 118, y: 138 }, [collapsedNote])?.id).toBe(collapsedNote.id);
  });

  it('translates and scales internal freehand strokes when moving or resizing note', () => {
    const moved = offsetAnnotation(sampleNote, 25, -15);
    expect(moved.box.x).toBe(125);
    expect(moved.box.y).toBe(105);
    expect(moved.strokes[0].points[0]).toMatchObject({ x: 145, y: 165 });

    const resized = transformAnnotation(sampleNote, {
      dx: 0,
      dy: 0,
      scaleX: 2,
      scaleY: 2,
      originX: 100,
      originY: 120
    }) as StickyNoteAnnotation;
    expect(resized.box.width).toBe(440);
    expect(resized.strokes[0].points[0].x).toBeCloseTo(140, 2);
    expect(resized.strokes[0].points[0].y).toBeCloseTo(240, 2);
  });

  it('round-trips both expanded and collapsed sticky notes through native PDF annotations', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 800]);

    const collapsedNote: StickyNoteAnnotation = {
      ...sampleNote,
      id: 'sticky_collapsed_1',
      box: { x: 360, y: 120, width: 200, height: 200 },
      collapsed: true
    };

    await syncNativeAnnotations(pdfDoc, {
      0: [sampleNote, collapsedNote]
    });

    const bytes = await pdfDoc.save();
    const reloaded = await PDFDocument.load(bytes);
    const imported = importNativeAnnotations(reloaded);

    expect(imported.length).toBe(2);
    const expImported = imported.find(e => e.annotation.id === sampleNote.id)?.annotation as StickyNoteAnnotation;
    const colImported = imported.find(e => e.annotation.id === collapsedNote.id)?.annotation as StickyNoteAnnotation;

    expect(expImported).toBeDefined();
    expect(expImported.type).toBe('sticky-note');
    expect(expImported.text).toBe(sampleNote.text);
    expect(expImported.author).toBe('Kia Gh');
    expect(expImported.collapsed).toBe(false);
    expect(expImported.strokes.length).toBe(1);
    expect(expImported.strokes[0].points.length).toBe(3);

    expect(colImported).toBeDefined();
    expect(colImported.type).toBe('sticky-note');
    expect(colImported.collapsed).toBe(true);
    expect(colImported.box).toEqual(collapsedNote.box);
  });
});
