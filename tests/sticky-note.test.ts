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
    expect(small.author).toBe('');
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

  it('clamps points strictly inside the Sticky Note card borders and transforms embedded items', () => {
    const outsidePt = { x: 50, y: 420, pressure: 0.6 };
    const clamped = stickyNoteTool.clampPointToNote(sampleNote, outsidePt, 4);

    expect(clamped.x).toBeGreaterThanOrEqual(sampleNote.box.x + 4);
    expect(clamped.x).toBeLessThanOrEqual(sampleNote.box.x + sampleNote.box.width - 4);
    expect(clamped.y).toBeGreaterThanOrEqual(sampleNote.box.y + 4);
    expect(clamped.y).toBeLessThanOrEqual(sampleNote.box.y + sampleNote.box.height - 4);

    const noteWithItems: StickyNoteAnnotation = {
      ...sampleNote,
      items: [
        {
          id: 'shape_1',
          type: 'rectangle',
          pageIndex: 0,
          layerId: 'layer-default',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          box: { x: 120, y: 150, width: 60, height: 40 },
          strokeColor: '#2563eb',
          strokeWidth: 2,
          strokeStyle: 'solid',
          opacity: 1
        }
      ]
    };

    const shifted = offsetAnnotation(noteWithItems, 25, -15) as StickyNoteAnnotation;
    expect((shifted.items?.[0] as any).box).toEqual({
      x: 145,
      y: 135,
      width: 60,
      height: 40
    });
  });

  it('resizes a collapsed Sticky Note icon independently without altering the expanded card dimensions', () => {
    const note = stickyNoteTool.createStickyNote(0, { x: 100, y: 120 }, {
      box: { x: 100, y: 120, width: 220, height: 180 },
      collapsed: true
    });

    const resized = transformAnnotation(note, {
      dx: 0,
      dy: 0,
      scaleX: 2.0,
      scaleY: 1.5,
      originX: 100,
      originY: 120
    }) as StickyNoteAnnotation;

    // Collapsed icon dimensions scale independently (default pin size is 38x38)
    const iconBox = stickyNoteTool.getCollapsedIconBox(resized);
    expect(iconBox.width).toBe(76);
    expect(iconBox.height).toBe(57);
    expect(getAnnotationSelectionBox(resized)).toEqual({ x: 100, y: 120, width: 76, height: 57, rotation: 0 });

    // Expanded note dimensions remain 220x180
    expect(resized.box.width).toBe(220);
    expect(resized.box.height).toBe(180);
  });

  it('expands a Sticky Note leftward/upward when near the right or bottom page edge and restores anchor on collapse', () => {
    const pageWidth = 600;
    const pageHeight = 800;
    const nearEdgeCollapsed = stickyNoteTool.createStickyNote(0, { x: 540, y: 720 }, {
      box: { x: 540, y: 720, width: 220, height: 190 },
      collapsed: true
    });

    const expanded = stickyNoteTool.expandStickyNoteForPage(nearEdgeCollapsed, pageWidth, pageHeight);
    expect(expanded.collapsed).toBe(false);
    // Must fit within [8 .. pageWidth - 8] and [8 .. pageHeight - 8]
    expect(expanded.box.x + expanded.box.width).toBeLessThanOrEqual(pageWidth - 8);
    expect(expanded.box.y + expanded.box.height).toBeLessThanOrEqual(pageHeight - 8);
    expect(expanded.anchorX).toBe(540);
    expect(expanded.anchorY).toBe(720);

    // Collapsing returns the pin icon back to its original anchor near the right/bottom edge
    const recollapsed = stickyNoteTool.collapseStickyNote(expanded);
    expect(recollapsed.collapsed).toBe(true);
    expect(recollapsed.box.x).toBe(540);
    expect(recollapsed.box.y).toBe(720);
  });

  it('assigns strictly monotonic timestamps to in-note strokes and shapes so newer strokes render above older shapes', () => {
    const note = stickyNoteTool.createStickyNote(0, { x: 80, y: 80 }, {});
    const tShape = stickyNoteTool.nextContentTimestamp(note);
    note.items = [
      {
        id: 'shape_1',
        pageIndex: 0,
        layerId: 'layer-default',
        type: 'rectangle',
        box: { x: 100, y: 130, width: 120, height: 80 },
        strokeColor: '#ef4444',
        fillColor: '#3b82f6',
        fillOpacity: 1,
        strokeWidth: 2,
        outline: true,
        strokeStyle: 'solid',
        cornerRadius: 0,
        opacity: 1,
        createdAt: tShape,
        updatedAt: tShape
      }
    ];

    const tStroke = stickyNoteTool.nextContentTimestamp(note);
    expect(tStroke).toBeGreaterThan(tShape);
    note.strokes = [
      {
        id: 'stroke_1',
        tool: 'pen',
        points: [
          { x: 110, y: 140, pressure: 0.5 },
          { x: 180, y: 180, pressure: 0.5 }
        ],
        color: '#10b981',
        strokeWidth: 3,
        opacity: 1,
        createdAt: tStroke
      }
    ];

    const fillStylesUsed: string[] = [];
    const ctx: any = {
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arcTo: () => {},
      arc: () => {},
      rect: () => {},
      roundRect: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
      clip: () => {},
      fill: function () {
        fillStylesUsed.push(String(this.fillStyle));
      },
      stroke: () => {},
      fillText: () => {},
      setLineDash: () => {},
      measureText: (txt: string) => ({ width: txt.length * 7 }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      font: ''
    };

    stickyNoteTool.renderToCanvas(ctx, note, 1, false);
    // Shape interior fill (#3b82f6) must be painted BEFORE the newer pen stroke (#10b981)
    const shapeFillIdx = fillStylesUsed.indexOf('#3b82f6');
    const penStrokeIdx = fillStylesUsed.lastIndexOf('#10b981');
    expect(shapeFillIdx).toBeGreaterThanOrEqual(0);
    expect(penStrokeIdx).toBeGreaterThan(shapeFillIdx);
  });
});

