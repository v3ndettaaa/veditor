import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAngleDegrees, computeMeasurementValue } from '../../annotations/tools/measure';
import { replaceFileExtension } from '../../ui/components/save-as-dialog';
import { buildAnnotationsMarkdownSummary, describeAnnotationItem } from '../annotations-summary';
import { buildZipArchive, decryptZipCryptoEntry } from '../../io/zip';
import {
  moveAnnotationVertex,
  transformAnnotation,
  offsetAnnotation,
  embedAnnotationsInStickyNote,
  appendTextToStickyNote,
  wrapPlainTextForTextBox,
  computeSelectionBoxTransform,
  computeVertexResizeTransform
} from '../../annotations/selection';
import {
  getStickyNoteLayoutMetrics,
  getStickyNoteContentRect,
  findExpandedStickyNoteTarget,
  computeViewportStickyNoteBox,
  stickyNoteTool
} from '../../annotations/tools/sticky-note';
import { computeScrubSliderValue } from '../../ui/slider-scrub';
import { detectToolbarSnapEdge, clampToolbarFloatPos } from '../../ui/toolbar-dock';
import type { MeasurementAnnotation, ShapeAnnotation, StampAnnotation, StickyNoteAnnotation, TextAnnotation } from '../types';

describe('Pure Logic Verification (node:test)', () => {
  it('computes 3-point angle degrees and area measurements accurately', () => {
    assert.equal(Math.round(computeAngleDegrees({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 })), 90);
    const areaRes = computeMeasurementValue(
      'measure-area',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      'cm',
      0.1
    );
    assert.ok(Math.abs(areaRes.measuredValue - 100) < 1e-6);
    assert.equal(areaRes.label, '100.00 cm²');
  });

  it('replaces file extensions cleanly for all supported export formats', () => {
    assert.equal(replaceFileExtension('report.pdf', 'png'), 'report.png');
    assert.equal(replaceFileExtension('report.pdf', 'jpeg'), 'report.jpg');
    assert.equal(replaceFileExtension('report.pdf', 'xfdf'), 'report.xfdf');
    assert.equal(replaceFileExtension('report.pdf', 'json'), 'report.json');
  });

  it('formats Markdown summary with bookmarks and annotations', () => {
    const md = buildAnnotationsMarkdownSummary({
      name: 'Sample.pdf',
      pageCount: 2,
      userBookmarks: [{ id: 'b1', title: 'Intro', pageIndex: 0, createdAt: 1 }],
      annotations: {
        0: [
          {
            id: 'a1',
            pageIndex: 0,
            layerId: 'default',
            type: 'measure-angle',
            box: { x: 0, y: 0, width: 50, height: 50 },
            color: '#ef4444',
            opacity: 1,
            points: [{ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }],
            strokeWidth: 2,
            scaleRatio: 1,
            unit: 'cm',
            measuredValue: 90,
            label: '90.0°',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    }, 'en');
    assert.ok(md.includes('# Sample.pdf'));
    assert.ok(md.includes('**[Page 1] Intro**'));
    assert.ok(md.includes('Angle: 90.0°'));
    const info = describeAnnotationItem({
      id: 'a1',
      pageIndex: 0,
      layerId: 'default',
      type: 'measure-area',
      box: { x: 0, y: 0, width: 50, height: 50 },
      color: '#ef4444',
      opacity: 1,
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }],
      strokeWidth: 2,
      scaleRatio: 1,
      unit: 'cm',
      measuredValue: 12.5,
      label: '12.50 cm²',
      createdAt: 1,
      updatedAt: 1
    }, 'en');
    assert.equal(info.icon, 'measureArea');
  });

  it('encrypts and round-trips password-protected ZIP archives with ZipCrypto', () => {
    const plain = new TextEncoder().encode('<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/></xfdf>');
    const archive = buildZipArchive([{ name: 'notes.xfdf', data: plain }], 's3cret!Pass');
    // Local header starts with PK\x03\x04 and general purpose bit flag includes 0x0001
    assert.equal(archive[0], 0x50);
    assert.equal(archive[1], 0x4b);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const flags = view.getUint16(6, true);
    assert.ok((flags & 0x0001) !== 0, 'ZIP encryption bit flag must be set');
    const compSize = view.getUint32(18, true);
    const fnameLen = view.getUint16(26, true);
    const crc = view.getUint32(14, true);
    const dataOffset = 30 + fnameLen;
    const encryptedSlice = archive.slice(dataOffset, dataOffset + compSize);

    // Wrong password throws Invalid ZIP password
    assert.throws(() => decryptZipCryptoEntry(encryptedSlice, crc, 'wrong-password'), /Invalid ZIP password/);
    // Correct password recovers exact bytes
    const decrypted = decryptZipCryptoEntry(encryptedSlice, crc, 's3cret!Pass');
    assert.deepEqual(Array.from(decrypted), Array.from(plain));
  });

  it('recalculates distance, angle, and area measurements live when moving vertices or scaling', () => {
    const areaAnn: MeasurementAnnotation = {
      id: 'm_area',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'measure-area',
      box: { x: 0, y: 0, width: 100, height: 100 },
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      unit: 'cm',
      scaleRatio: 0.1,
      color: '#2563eb',
      strokeWidth: 2,
      measuredValue: 100,
      label: '100.00 cm²',
      opacity: 1,
      createdAt: 1,
      updatedAt: 1
    };

    // Move corner (100,100) to (200,100) and (100,0) -> expand width 100 -> 200 (trapezoid 15000px^2 = 150 cm^2)
    const editedArea = moveAnnotationVertex(areaAnn, 2, { x: 200, y: 100 }) as MeasurementAnnotation;
    assert.ok(Math.abs(editedArea.measuredValue - 150) < 1e-4);
    assert.equal(editedArea.label, '150.00 cm²');

    // Uniform 2x transform scales area by 4x (100 -> 400 cm^2)
    const scaledArea = transformAnnotation(areaAnn, {
      dx: 0, dy: 0, scaleX: 2, scaleY: 2, originX: 0, originY: 0
    }) as MeasurementAnnotation;
    assert.ok(Math.abs(scaledArea.measuredValue - 400) < 1e-4);
    assert.equal(scaledArea.label, '400.00 cm²');

    // Angle measurement live recalculation: 90° -> 45° when moving endpoint
    const angleAnn: MeasurementAnnotation = {
      ...areaAnn,
      id: 'm_angle',
      type: 'measure-angle',
      points: [{ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }],
      measuredValue: 90,
      label: '90.0°'
    };
    const editedAngle = moveAnnotationVertex(angleAnn, 0, { x: 100, y: 100 }) as MeasurementAnnotation;
    assert.ok(Math.abs(editedAngle.measuredValue - 45) < 1e-4);
    assert.equal(editedAngle.label, '45.0°');

    // Distance measurement live recalculation: 100px * 0.1 = 10 cm -> 250px * 0.1 = 25 cm
    const distAnn: MeasurementAnnotation = {
      ...areaAnn,
      id: 'm_dist',
      type: 'measure-distance',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      measuredValue: 10,
      label: '10.00 cm'
    };
    const editedDist = moveAnnotationVertex(distAnn, 1, { x: 250, y: 0 }) as MeasurementAnnotation;
    assert.ok(Math.abs(editedDist.measuredValue - 25) < 1e-4);
    assert.equal(editedDist.label, '25.00 cm');
  });

  it('preserves exact aspect ratio across box handles and vertex handles when holding Shift', () => {
    const box = { x: 50, y: 50, width: 200, height: 100 }; // 2:1 ratio
    // Corner resize with Shift
    const tCorner = computeSelectionBoxTransform(box, 'resize', 'se', { x: 250, y: 150 }, { x: 350, y: 160 }, true);
    assert.ok(Math.abs(tCorner.scaleX - tCorner.scaleY) < 1e-6);
    // Edge resize ('e') with Shift also scales uniformly around vertical center!
    const tEdge = computeSelectionBoxTransform(box, 'resize', 'e', { x: 250, y: 100 }, { x: 350, y: 100 }, true);
    assert.equal(tEdge.scaleX, 1.5);
    assert.equal(tEdge.scaleY, 1.5);

    // Vertex drag with Shift on a triangle polygon scales uniformly anchored at opposite corner
    const poly: ShapeAnnotation = {
      id: 'poly1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'polygon',
      box: { x: 0, y: 0, width: 100, height: 50 },
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }],
      strokeColor: '#000',
      strokeWidth: 2,
      strokeStyle: 'solid',
      opacity: 1,
      createdAt: 1,
      updatedAt: 1
    };
    const vt = computeVertexResizeTransform(poly, 2, { x: 200, y: 100 });
    assert.ok(vt !== null);
    assert.ok(Math.abs(vt.scaleX - 2) < 1e-6);
    assert.ok(Math.abs(vt.scaleY - 2) < 1e-6);
    const scaledPoly = transformAnnotation(poly, vt) as ShapeAnnotation;
    assert.ok(Math.abs(scaledPoly.box.width / scaledPoly.box.height - 2) < 0.05);
  });

  it('scales sticky note internal layout metrics and fits viewport placement cleanly when zoomed', () => {
    const full = getStickyNoteLayoutMetrics({ x: 0, y: 0, width: 220, height: 220 });
    assert.equal(full.uiScale, 1);
    assert.equal(full.headerHeight, 36);
    assert.equal(full.btnSize, 22);

    const small = getStickyNoteLayoutMetrics({ x: 0, y: 0, width: 84, height: 84 });
    assert.ok(Math.abs(small.uiScale - 0.4) < 1e-6);
    assert.ok(small.headerHeight < 20);
    assert.ok(small.btnSize < 12);
    assert.ok(small.padX < full.padX);

    // Shrinking a sticky note via transformAnnotation preserves ratio & scales fontSize
    const note = stickyNoteTool.createStickyNote(0, 'layer-default', { x: 10, y: 10, width: 200, height: 200 }, 'Hello', { fontSize: 20 });
    const shrunk = transformAnnotation(note, { dx: 0, dy: 0, scaleX: 0.4, scaleY: 0.4, originX: 10, originY: 10 }) as StickyNoteAnnotation;
    assert.equal(shrunk.box.width, 80);
    assert.equal(shrunk.box.height, 80);
    assert.equal(shrunk.fontSize, 8);

    // At 3x zoom inside a visible sub-rect, sticky note spawns compact in page coords and fully inside visible bounds
    const visRect = { left: 100, top: 200, right: 300, bottom: 420 };
    const placed = computeViewportStickyNoteBox(612, 792, 3.0, visRect);
    assert.ok(placed.box.x >= visRect.left);
    assert.ok(placed.box.x + placed.box.width <= visRect.right);
    assert.ok(placed.box.y >= visRect.top);
    assert.ok(placed.box.y + placed.box.height <= visRect.bottom);
    assert.ok(placed.box.width < 120, 'Zoomed 3x sticky note width in page units should be compact');
  });

  it('computes continuous pointer-scrub slider values with step snapping, bounds clamping, and RTL support', () => {
    // 50% along 200px wide slider [0..100] step 1 -> 50
    const mid = computeScrubSliderValue(200, 100, 200, 0, 100, 1, false);
    assert.equal(mid.value, 50);
    assert.equal(mid.pct, 50);

    // Dragging past left/right bounds clamps cleanly
    assert.equal(computeScrubSliderValue(50, 100, 200, 1, 50, 1, false).value, 1);
    assert.equal(computeScrubSliderValue(450, 100, 200, 1, 50, 1, false).value, 50);

    // Decimal step snapping (0.5 step on 0.5..40) without floating-point artifacts
    const halfStep = computeScrubSliderValue(150, 100, 200, 0.5, 40, 0.5, false);
    assert.equal(halfStep.value, 10.5);

    // RTL flips horizontal fill direction: dragging near left edge sets high value
    const rtlLeft = computeScrubSliderValue(100, 100, 200, 0, 100, 1, true);
    assert.equal(rtlLeft.value, 100);
    assert.equal(rtlLeft.pct, 100);
  });

  it('detects 4-edge magnetic toolbar snap zones and clamps free-floating coordinates inside viewport', () => {
    const vw = 1440;
    const vh = 900;
    const headerH = 52;

    assert.equal(detectToolbarSnapEdge(720, 80, vw, vh, headerH), 'top');
    assert.equal(detectToolbarSnapEdge(720, 875, vw, vh, headerH), 'bottom');
    assert.equal(detectToolbarSnapEdge(25, 450, vw, vh, headerH), 'left');
    assert.equal(detectToolbarSnapEdge(1420, 450, vw, vh, headerH), 'right');
    assert.equal(detectToolbarSnapEdge(720, 450, vw, vh, headerH), null);

    // Clamp keeps floating toolbar clear of header & screen bounds
    const clampedTopLeft = clampToolbarFloatPos(-40, 10, 620, 52, vw, vh, headerH, 12);
    assert.equal(clampedTopLeft.x, 12);
    assert.equal(clampedTopLeft.y, headerH + 8);

    const clampedBottomRight = clampToolbarFloatPos(1300, 890, 620, 52, vw, vh, headerH, 12);
    assert.equal(clampedBottomRight.x, vw - 620 - 12);
    assert.equal(clampedBottomRight.y, vh - 52 - 12);
  });

  it('embeds pasted images and shapes inside expanded sticky notes, clamps to content area, and preserves on collapse/move', () => {
    const note = stickyNoteTool.createStickyNote(0, 'layer-default', { x: 100, y: 100, width: 220, height: 220 }, '');
    const contentRect = getStickyNoteContentRect(note);

    const bigStamp: StampAnnotation = {
      id: 'img_1',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'stamp',
      stampType: 'custom',
      imageUrl: 'data:image/png;base64,AA==',
      box: { x: 0, y: 0, width: 440, height: 220 },
      opacity: 1,
      createdAt: 1,
      updatedAt: 1
    };

    const { updatedNote, insertedItems } = embedAnnotationsInStickyNote(note, [bigStamp], { x: 300, y: 305 }, { idFactory: () => 'embedded_1' });
    assert.equal(insertedItems.length, 1);
    const emb = insertedItems[0];
    assert.equal(emb.id, 'embedded_1');
    assert.ok(emb.box.x >= contentRect.x - 1e-6);
    assert.ok(emb.box.y >= contentRect.y - 1e-6);
    assert.ok(emb.box.x + emb.box.width <= contentRect.x + contentRect.width + 1e-6);
    assert.ok(emb.box.y + emb.box.height <= contentRect.y + contentRect.height + 1e-6);
    assert.ok(Math.abs((emb.box.width / emb.box.height) - 2) < 1e-3);

    const moved = offsetAnnotation(stickyNoteTool.collapseStickyNote(updatedNote), 30, -20) as StickyNoteAnnotation;
    assert.equal(moved.collapsed, true);
    assert.equal(moved.items?.length, 1);
    assert.ok(Math.abs(moved.items![0].box.x - (emb.box.x + 30)) < 1e-6);
    assert.ok(Math.abs(moved.items![0].box.y - (emb.box.y - 20)) < 1e-6);

    assert.equal(findExpandedStickyNoteTarget([moved], { point: { x: 140, y: 120 }, allowSelectedFallback: false }), null);

    // Appending copied plain text & scaling embedded TextAnnotation padding inside Sticky Note
    const appended = appendTextToStickyNote(note, 'یادداشت آزمایشی');
    assert.equal(appended?.text, 'یادداشت آزمایشی');
    const appended2 = appendTextToStickyNote(appended!, 'Second line');
    assert.equal(appended2?.text, 'یادداشت آزمایشی\nSecond line');

    const textBox: TextAnnotation = {
      id: 'txt_node',
      pageIndex: 0,
      layerId: 'layer-default',
      type: 'text',
      box: { x: 0, y: 0, width: 400, height: 60 },
      text: 'Title',
      fontFamily: 'Manrope',
      fontSize: 20,
      color: '#111827',
      textAlign: 'left',
      padding: 10,
      opacity: 1,
      createdAt: 1,
      updatedAt: 1
    };
    const embeddedTxt = embedAnnotationsInStickyNote(note, [textBox]).insertedItems[0] as TextAnnotation;
    assert.ok(embeddedTxt.fontSize < 20);
    assert.ok((embeddedTxt.padding ?? 0) < 10);
    assert.ok(wrapPlainTextForTextBox('alpha beta gamma delta epsilon', 14).includes('\n'));
  });
});

