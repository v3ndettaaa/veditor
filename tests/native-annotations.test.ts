import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument, PDFHexString,
  PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts,
} from 'pdf-lib';
import type { Annotation, HighlighterAnnotation, ShapeAnnotation, StampAnnotation, TextAnnotation } from '../src/core/types';
import { importNativeAnnotations, stripImportedNativeAnnotations, syncNativeAnnotations } from '../src/core/native-annotations';
import { offsetAnnotation, transformAnnotation } from '../src/annotations/selection';

const key = PDFName.of;
type QuadHighlight = HighlighterAnnotation & { quadPoints: Array<Array<{ x: number; y: number }>> };

async function fixture(rotation = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  page.setCropBox(30, 40, 300, 400);
  page.setRotation(degrees(rotation));
  const font = await doc.embedFont(StandardFonts.CourierBoldOblique);
  await doc.flush();
  const definitions = [
    { Subtype: 'FreeText', Rect: [50, 340, 250, 400], Contents: PDFHexString.fromText('Hello\nworld'), DA: PDFString.of('/F1 14 Tf 0.2 0.4 0.6 rg'), DR: { Font: { F1: font.ref } }, Q: 2, C: [1, 1, 0.9], BS: { W: 0 } },
    { Subtype: 'Square', Rect: [60, 160, 160, 240], Contents: PDFString.of('Square note'), C: [1, 0, 0], IC: [0.2, 0.8, 0.4], BS: { W: 3, S: 'D', D: [7, 2] } },
    { Subtype: 'Circle', Rect: [180, 160, 240, 240], Contents: PDFString.of('Circle note'), C: [0, 0, 1], BS: { W: 2 } },
    { Subtype: 'Line', Rect: [50, 70, 240, 150], Contents: PDFString.of('Line note'), C: [0, 0, 0], IC: [1, 0.5, 0], L: [60, 80, 220, 130], LE: ['OpenArrow', 'ClosedArrow'], BS: { W: 2 } },
    { Subtype: 'Highlight', Rect: [50, 270, 260, 325], Contents: PDFString.of('Highlight note'), C: [1, 1, 0], CA: 0.4, QuadPoints: [55, 320, 220, 318, 55, 300, 220, 298, 60, 292, 250, 292, 60, 275, 250, 275] },
    { Subtype: 'Link', Rect: [30, 40, 90, 60], Contents: PDFString.of('Keep this link'), A: { S: 'URI', URI: PDFString.of('https://example.com') } },
  ];
  const refs = definitions.map((def, index) => doc.context.register(doc.context.obj({ Type: 'Annot', NM: PDFHexString.fromText(`fixture-${index}`), ...def })));
  page.node.set(key('Annots'), doc.context.obj(refs));
  return { doc, refs };
}

function group(doc: PDFDocument): Record<number, Annotation[]> {
  const result: Record<number, Annotation[]> = {};
  for (const { pageIndex, annotation } of importNativeAnnotations(doc)) (result[pageIndex] ??= []).push(annotation);
  return result;
}

function dicts(doc: PDFDocument): PDFDict[] {
  return doc.getPage(0).node.Annots()!.asArray().map(ref => doc.context.lookup(ref, PDFDict));
}

function getDict(doc: PDFDocument, id: string): PDFDict {
  return dicts(doc).find(dict => (dict.lookup(key('NM')) as PDFHexString | PDFString).decodeText() === id)!;
}

function array(dict: PDFDict, field: string): number[] {
  return dict.lookup(key(field), PDFArray).asArray().map(value => (dict.context.lookup(value) as PDFNumber).asNumber());
}

function appearance(dict: PDFDict): { content: string; stream: PDFRawStream } {
  const ap = dict.lookup(key('AP'), PDFDict);
  const stream = ap.context.lookup(ap.get(key('N'))) as PDFRawStream;
  return { stream, content: new TextDecoder().decode(decodePDFRawStream(stream).decode()) };
}

function shape(id = 'shape'): ShapeAnnotation {
  return { id, type: 'ellipse', pageIndex: 0, layerId: 'default', createdAt: 1, updatedAt: 1,
    box: { x: 20, y: 30, width: 90, height: 60 }, opacity: 0.8, rotation: Math.PI / 6,
    strokeColor: '#123456', fillColor: '#abcdef', strokeWidth: 3, strokeStyle: 'dashed', cornerRadius: 4 };
}

function textAnnotation(id = 'text'): TextAnnotation {
  return { id, type: 'text', pageIndex: 0, layerId: 'default', createdAt: 1, updatedAt: 2,
    box: { x: 20, y: 30, width: 220, height: 70 }, opacity: 0.7, rotation: 0.2,
    text: 'First line\nSecond line', color: '#214365', fontFamily: 'Times New Roman', fontWeight: 700,
    fontStyle: 'italic', fontSize: 18, textAlign: 'right', padding: 9, backgroundColor: '#eeeeee', borderColor: '#112233' };
}

describe('native annotation structural codec', () => {
  it('embeds Persian text as vector glyphs and reopens with editable Unicode contents', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    const ann = { ...textAnnotation(), text: 'سلام فارسی', fontFamily: 'Vazirmatn' };
    await syncNativeAnnotations(doc, { 0: [ann] }, async () => new Uint8Array(await readFile(
      new URL('../node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff', import.meta.url)
    )));
    const reopened = await PDFDocument.load(await doc.save());
    expect(importNativeAnnotations(reopened)[0].annotation).toEqual(ann);
    const ap = appearance(getDict(reopened, ann.id));
    expect(ap.content).toContain(' Tj');
    expect(ap.content).not.toContain(' Do');
    const fonts = ap.stream.dict.lookup(key('Resources'), PDFDict).lookup(key('Font'), PDFDict);
    const font = reopened.context.lookup(fonts.get(key('F0')), PDFDict);
    expect(font.lookup(key('Subtype'), PDFName).decodeText()).toBe('Type0');
  });
  it('imports the five supported subtypes and FreeText properties without mutating dictionaries', async () => {
    const { doc } = await fixture();
    const before = dicts(doc).map(dict => dict.toString());
    const imported = importNativeAnnotations(doc);
    expect(imported.map(e => e.annotation.type)).toEqual(['text', 'rectangle', 'ellipse', 'arrow', 'highlighter']);
    expect(imported[0].annotation).toMatchObject({ text: 'Hello\nworld', fontFamily: 'Courier New', fontWeight: 'bold', fontStyle: 'italic', fontSize: 14, textAlign: 'right', color: '#336699', box: { x: 20, y: 40, width: 200, height: 60 } });
    expect(imported[1].annotation).toMatchObject({ strokeStyle: 'dashed', strokeWidth: 3, fillColor: '#33cc66' });
    expect(imported[3].annotation).toMatchObject({ arrowStart: true, arrowEnd: true, points: [{ x: 30, y: 360 }, { x: 190, y: 310 }] });
    const highlight = imported[4].annotation as QuadHighlight;
    expect(highlight.points).toEqual([]);
    expect(highlight.quadPoints).toHaveLength(2);
    expect(highlight.quadPoints.flat().every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
    expect(dicts(doc).map(dict => dict.toString())).toEqual(before);
  });

  it('roundtrips edits and properties with vector appearances and valid font resources', async () => {
    const { doc, refs } = await fixture();
    const annotations = group(doc);
    annotations[0] = annotations[0].map(a => offsetAnnotation(a, 12, 7));
    const text = annotations[0][0] as TextAnnotation;
    Object.assign(text, { text: 'Edited content', textAlign: 'center', fontSize: 19, fontWeight: 700, fontStyle: 'italic', padding: 5, rotation: 0.4 });
    const square = annotations[0][1] as ShapeAnnotation;
    Object.assign(square, { rotation: 0.6, fillColor: '#aabbcc', outline: true, cornerRadius: 8 });
    const unknown = doc.context.lookup(refs[5], PDFDict).toString();
    await syncNativeAnnotations(doc, annotations);
    expect(importNativeAnnotations(doc).map(e => e.annotation)).toEqual(annotations[0]);
    expect(doc.context.lookup(refs[5], PDFDict).toString()).toBe(unknown);
    expect(doc.getPage(0).node.Annots()!.asArray()).toContain(refs[5]);
    for (const a of annotations[0]) {
      const dict = getDict(doc, a.id);
      expect(dict.lookup(key('VEditorNative'), PDFNumber).asNumber()).toBe(1);
      expect(JSON.parse(dict.lookup(key('VEditorData'), PDFHexString).decodeText())).toEqual(a);
      const { stream, content } = appearance(dict);
      expect(content).not.toMatch(/\bbe\b|\bDo\b/);
      expect(content).toContain(' cm');
      expect(stream.dict.lookup(key('Resources'), PDFDict).has(key('ExtGState'))).toBe(true);
      if (a.type === 'ellipse') expect(content.match(/ c\n/g)).toHaveLength(4);
      if (a.type === 'text') {
        expect(content).toContain(' Tj');
        const fonts = stream.dict.lookup(key('Resources'), PDFDict).lookup(key('Font'), PDFDict);
        expect(fonts.get(key('F0'))).toBeInstanceOf(PDFRef);
        expect(dict.lookup(key('DR'), PDFDict).lookup(key('Font'), PDFDict).get(key('F0'))).toBe(fonts.get(key('F0')));
      }
    }
    expect(getDict(doc, 'fixture-1').lookup(key('Contents'), PDFString).decodeText()).toBe('Square note');
    expect(array(getDict(doc, 'fixture-1').lookup(key('BS'), PDFDict), 'D')).toEqual([7, 2]);
    expect(getDict(doc, 'fixture-3').lookup(key('LE'), PDFArray).toString()).toBe('[ /OpenArrow /ClosedArrow ]');
    const loaded = await PDFDocument.load(await doc.save());
    expect(group(loaded)).toEqual(annotations);
    const objects = loaded.context.enumerateIndirectObjects().length;
    const dictionaries = dicts(loaded).map(d => d.toString());
    await syncNativeAnnotations(loaded, group(loaded));
    expect(loaded.context.enumerateIndirectObjects()).toHaveLength(objects);
    expect(dicts(loaded).map(d => d.toString())).toEqual(dictionaries);
    expect(group(await PDFDocument.load(await loaded.save()))).toEqual(annotations);
  });

  it('prunes deleted imported entries from the input PDF without relying on metadata', async () => {
    const { doc, refs } = await fixture();
    const annotations = group(doc);
    annotations[0] = annotations[0].filter(a => a.id !== 'fixture-1' && a.id !== 'fixture-4');
    await syncNativeAnnotations(doc, annotations);
    expect(importNativeAnnotations(doc)).toHaveLength(3);
    expect(doc.getPage(0).node.Annots()!.asArray()).not.toContain(refs[1]);
    expect(doc.getPage(0).node.Annots()!.asArray()).not.toContain(refs[4]);
    expect(doc.getPage(0).node.Annots()!.asArray()).toContain(refs[5]);
    await syncNativeAnnotations(doc, {});
    expect(doc.getPage(0).node.Annots()!.asArray()).toEqual([refs[5]]);
  });

  it.each([0, 90, 180, 270])('preserves native coordinates through crop offsets and rotation %s', async rotation => {
    const { doc } = await fixture(rotation);
    const originalLine = array(getDict(doc, 'fixture-3'), 'L');
    const originalQuads = array(getDict(doc, 'fixture-4'), 'QuadPoints');
    const original = group(doc);
    await syncNativeAnnotations(doc, original);
    array(getDict(doc, 'fixture-3'), 'L').forEach((v, i) => expect(v).toBeCloseTo(originalLine[i], 6));
    array(getDict(doc, 'fixture-4'), 'QuadPoints').forEach((v, i) => expect(v).toBeCloseTo(originalQuads[i], 6));
    expect(group(await PDFDocument.load(await doc.save()))).toEqual(original);
    const { content } = appearance(getDict(doc, 'fixture-0'));
    const matrix = content.split('\n')[1].split(' ').slice(0, 6).map(Number);
    expect(matrix.slice(0, 4)).toEqual([1, 0, 0, -1]);
  });

  it('composes annotation rotation into AP and Line coordinates', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    page.setCropBox(30, 40, 300, 400);
    page.setRotation(degrees(90));
    const line: ShapeAnnotation = { ...shape('line'), type: 'line', box: { x: 20, y: 30, width: 100, height: 0 }, points: [{ x: 20, y: 30 }, { x: 120, y: 30 }], rotation: Math.PI / 2 };
    await syncNativeAnnotations(doc, { 0: [line] });
    const dict = getDict(doc, 'line');
    array(dict, 'L').forEach((v, i) => expect(v).toBeCloseTo([10, 110, 110, 110][i], 6));
    const matrix = appearance(dict).content.split('\n')[1].split(' ').slice(0, 6).map(Number);
    expect(matrix.slice(0, 4)).toEqual([1, 0, 0, -1]);
    expect(importNativeAnnotations(doc)[0].annotation).toEqual(line);
  });

  it('moves and resizes normalized quads through existing selection transforms', async () => {
    const { doc } = await fixture();
    const highlight = importNativeAnnotations(doc)[4].annotation as QuadHighlight;
    const moved = offsetAnnotation(highlight, 10, 15);
    const resized = transformAnnotation(moved, { dx: 5, dy: 3, scaleX: 1.2, scaleY: 1.5, originX: moved.box.x, originY: moved.box.y });
    expect(resized.quadPoints).toEqual(highlight.quadPoints);
    expect(resized.points).toEqual([]);
    await syncNativeAnnotations(doc, { 0: [resized] });
    const coords = array(getDict(doc, highlight.id), 'QuadPoints');
    const p = resized.quadPoints[0][0];
    expect(coords[0]).toBeCloseTo(30 + resized.box.x + p.x * resized.box.width);
    expect(coords[1]).toBeCloseTo(440 - resized.box.y - p.y * resized.box.height);
    expect(importNativeAnnotations(doc)[0].annotation).toEqual(resized);
  });

  it('uses NM and page/ref IDs deterministically, with direct-dictionary fallback', async () => {
    const { doc, refs } = await fixture();
    getDict(doc, 'fixture-1').delete(key('NM'));
    const direct = doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 20, 40, 60] });
    doc.getPage(0).node.Annots()!.push(direct);
    const imported = importNativeAnnotations(doc);
    expect(imported[1].annotation.id).toBe(`native-0-${refs[1].objectNumber}-${refs[1].generationNumber}`);
    expect(importNativeAnnotations(doc)).toEqual(imported);
    const loaded = await PDFDocument.load(await doc.save());
    expect(importNativeAnnotations(loaded).map(e => e.annotation.id)).toEqual(imported.map(e => e.annotation.id));
    await syncNativeAnnotations(loaded, group(loaded));
    expect(importNativeAnnotations(loaded).map(e => e.annotation.id)).toEqual(imported.map(e => e.annotation.id));
  });

  it('retains malformed, hidden, unsupported and corrupt-metadata annotations during import, strip and delete', async () => {
    const { doc, refs } = await fixture();
    const invalid = [
      { Subtype: 'Square', Rect: [1, 2, 3] },
      { Subtype: 'Square', Rect: [1, 2, 10, 20], F: 2 },
      { Subtype: 'Circle', Rect: [1, 2, 10, 20], BS: { W: PDFString.of('bad') } },
      { Subtype: 'Line', Rect: [1, 2, 10, 20], L: [1, 2, 3] },
      { Subtype: 'Line', Rect: [1, 2, 10, 20], L: [1, 2, 3, 4], LE: ['Circle', 'None'] },
      { Subtype: 'Highlight', Rect: [1, 2, 10, 20], QuadPoints: [1, 2, 3, 4] },
      { Subtype: 'Highlight', Rect: [1, 2, 10, 20], QuadPoints: [1, 2, 2, 2, 3, 2, 4, 2] },
      { Subtype: 'Highlight', Rect: [1, 2, 10, 20], QuadPoints: [1, 20, 100, 20, 1, 2, 100, 2] },
      { Subtype: 'FreeText', Rect: [1, 2, 10, 20], RC: PDFString.of('<body>rich text</body>') },
      { Subtype: 'FreeText', Rect: [1, 2, 10, 20], Contents: PDFNumber.of(12) },
      { Subtype: 'Square', Rect: [1, 2, 10, 20], VEditorNative: 1, VEditorData: PDFString.of('{bad') },
      { Subtype: 'Square', Rect: [1, 2, 10, 20], VEditorNative: 1, VEditorData: PDFHexString.fromText(JSON.stringify({ ...shape(), box: { x: 'bad' } })) },
      { Subtype: 'Square', Rect: [1, 2, 10, 20], C: [2, 0, 0] },
      { Subtype: 'Square', Rect: [1, 2, 10, 20], BE: { S: 'C', I: 2 } },
    ].map(d => doc.context.register(doc.context.obj(d)));
    const annots = doc.getPage(0).node.Annots()!;
    for (const ref of invalid) annots.push(ref);
    annots.push(PDFNumber.of(42));
    annots.push(PDFRef.of(99999));
    expect(importNativeAnnotations(doc)).toHaveLength(5);
    const before = invalid.map(ref => doc.context.lookup(ref)!.toString());
    const copy = await PDFDocument.load(await doc.save());
    expect(stripImportedNativeAnnotations(copy)).toBe(true);
    expect(stripImportedNativeAnnotations(copy)).toBe(false);
    expect(copy.getPage(0).node.Annots()!.size()).toBe(invalid.length + 3);
    await syncNativeAnnotations(doc, {});
    expect(doc.getPage(0).node.Annots()!.size()).toBe(invalid.length + 3);
    expect(doc.getPage(0).node.Annots()!.asArray()).toContain(refs[5]);
    expect(invalid.map(ref => doc.context.lookup(ref)!.toString())).toEqual(before);
  });

  it('rejects invalid internal models rather than hiding their original PDF appearance', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await syncNativeAnnotations(doc, { 0: [textAnnotation()] });
    const dict = getDict(doc, 'text');
    dict.set(key('VEditorData'), PDFHexString.fromText(JSON.stringify({ ...textAnnotation(), opacity: 5 })));
    expect(importNativeAnnotations(doc)).toEqual([]);
    const before = dict.toString();
    expect(stripImportedNativeAnnotations(doc)).toBe(false);
    await syncNativeAnnotations(doc, {});
    expect(dicts(doc)[0].toString()).toBe(before);
  });

  it('rejects unsupported Unicode explicitly and preserves all original annotation references', async () => {
    const { doc } = await fixture();
    const annotations = group(doc);
    (annotations[0][0] as TextAnnotation).text = 'متن فارسی 😀';
    const before = doc.getPage(0).node.Annots()!.toString();
    const dictionaries = dicts(doc).map(d => d.toString());
    await expect(syncNativeAnnotations(doc, annotations)).rejects.toThrow(/WinAnsi.*Content was preserved/);
    expect(doc.getPage(0).node.Annots()!.toString()).toBe(before);
    expect(dicts(doc).map(d => d.toString())).toEqual(dictionaries);
    const text = getDict(doc, 'fixture-0');
    text.set(key('Contents'), PDFHexString.fromText('متن فارسی 😀'));
    expect(importNativeAnnotations(doc)[0].annotation).toMatchObject({ text: 'متن فارسی 😀' });
  });

  it('validates every page before committing changes and leaves non-native models alone', async () => {
    const { doc } = await fixture();
    doc.addPage();
    const before = dicts(doc).map(d => d.toString());
    const invalid = { ...textAnnotation(), pageIndex: 1, text: '😀' };
    await expect(syncNativeAnnotations(doc, { 0: [shape()], 1: [invalid] })).rejects.toThrow('WinAnsi');
    expect(dicts(doc).map(d => d.toString())).toEqual(before);
    const ink: HighlighterAnnotation = { ...shape('ink'), type: 'highlighter', points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 20, y: 20, pressure: 0.5 }], color: '#ffff00', blendMode: 'multiply' };
    await syncNativeAnnotations(doc, { 0: [ink] });
    expect(importNativeAnnotations(doc)).toEqual([]);
    expect(dicts(doc)).toHaveLength(1);
  });

  it('rejects invalid geometry, colors and multi-segment lines without partial deletion', async () => {
    const { doc } = await fixture();
    const before = doc.getPage(0).node.Annots()!.toString();
    for (const invalid of [
      { ...shape(), opacity: NaN },
      { ...shape(), strokeColor: 'not-a-color' },
      { ...shape(), box: { x: 0, y: 0, width: -5, height: 10 } },
      { ...shape(), type: 'line', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 4, y: 5 }] },
    ]) {
      await expect(syncNativeAnnotations(doc, { 0: [invalid as Annotation] })).rejects.toThrow('Invalid');
      expect(doc.getPage(0).node.Annots()!.toString()).toBe(before);
    }
  });

  it('creates new annotations and roundtrips all edit properties', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const annotations = [shape(), textAnnotation(), { ...shape('rectangle'), type: 'rectangle', outline: false } as ShapeAnnotation];
    await syncNativeAnnotations(doc, { 0: annotations });
    const loaded = await PDFDocument.load(await doc.save());
    expect(group(loaded)).toEqual({ 0: annotations });
    await syncNativeAnnotations(loaded, {});
    expect(loaded.getPage(0).node.Annots()!.size()).toBe(0);
  });

  it('roundtrips recognized polygons, freeform shapes and preset stamps', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    const polygon: ShapeAnnotation = { ...shape('poly'), type: 'polygon', points: [{ x: 10, y: 10 }, { x: 90, y: 12 }, { x: 60, y: 70 }], fillColor: '#aabbcc' };
    const freeform: ShapeAnnotation = { ...shape('free'), type: 'freeform-shape', points: [{ x: 100, y: 10 }, { x: 180, y: 40 }, { x: 120, y: 90 }, { x: 90, y: 50 }] };
    const stamp: StampAnnotation = { id: 'stamp', pageIndex: 0, layerId: 'default', type: 'stamp', box: { x: 20, y: 30, width: 180, height: 64 }, opacity: 1, createdAt: 1, updatedAt: 1, stampType: 'preset', presetKey: 'APPROVED', color: '#16a34a' };
    await syncNativeAnnotations(doc, { 0: [polygon, freeform, stamp] });
    const loaded = await PDFDocument.load(await doc.save());
    expect(importNativeAnnotations(loaded).map(e => e.annotation)).toEqual([polygon, freeform, stamp]);
    const dict = getDict(loaded, 'poly');
    expect(array(dict, 'Vertices')).toHaveLength(6);
    expect(dict.lookup(key('Subtype'), PDFName).decodeText()).toBe('Polygon');
    expect(getDict(loaded, 'free').lookup(key('Subtype'), PDFName).decodeText()).toBe('PolyLine');
    expect(getDict(loaded, 'stamp').lookup(key('Subtype'), PDFName).decodeText()).toBe('Stamp');
    expect(appearance(getDict(loaded, 'stamp')).content).toContain(' Tj');
    await syncNativeAnnotations(loaded, {});
    expect(loaded.getPage(0).node.Annots()!.size()).toBe(0);
  });

  it('imports external polygons, polylines and stamps as editable annotations', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    const refs = [
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Polygon', Rect: [10, 10, 110, 90], Vertices: [10, 10, 110, 10, 60, 90], C: [1, 0, 0], IC: [0.5, 0.5, 0.5], BS: { W: 2 } })),
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'PolyLine', Rect: [10, 100, 110, 160], Vertices: [10, 100, 110, 130, 60, 160], C: [0, 0, 1], BS: { W: 1 } })),
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 130, 60], Name: PDFName.of('Approved'), C: [0.1, 0.6, 0.3] }))
    ];
    page.node.set(key('Annots'), doc.context.obj(refs));
    const imported = importNativeAnnotations(doc).map(e => e.annotation);
    expect(imported.map(a => a.type)).toEqual(['polygon', 'freeform-shape', 'stamp']);
    const annotations: Record<number, Annotation[]> = { 0: imported };
    await syncNativeAnnotations(doc, annotations);
    const loaded = await PDFDocument.load(await doc.save());
    expect(importNativeAnnotations(loaded).map(e => e.annotation)).toEqual(imported);
  });

  it('keeps malformed external polygons and stamps as preserved unknowns', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    const refs = [
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Polygon', Rect: [10, 10, 110, 90], Vertices: [10, 10, 110, 10], BS: { W: 2 } })),
      doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [10, 10, 130, 60] }))
    ];
    page.node.set(key('Annots'), doc.context.obj(refs));
    expect(importNativeAnnotations(doc)).toEqual([]);
    await syncNativeAnnotations(doc, {});
    expect(doc.getPage(0).node.Annots()!.asArray()).toEqual(refs);
  });

  it('moves recognized polygons through a second sync without geometry drift', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 500]);
    const anns: Annotation[] = [
      { ...shape('poly'), type: 'polygon', points: [{ x: 10, y: 10 }, { x: 90, y: 12 }, { x: 60, y: 70 }] },
      { ...shape('free'), type: 'freeform-shape', points: [{ x: 100, y: 10 }, { x: 180, y: 40 }, { x: 120, y: 90 }] }
    ];
    await syncNativeAnnotations(doc, { 0: anns });
    anns[0] = offsetAnnotation(anns[0], 15, 5);
    await syncNativeAnnotations(doc, { 0: anns });
    const loaded = await PDFDocument.load(await doc.save());
    const restored = importNativeAnnotations(loaded).map(e => e.annotation);
    expect(restored).toEqual(anns);
    expect(loaded.getPage(0).node.Annots()!.size()).toBe(2);
  });
});
