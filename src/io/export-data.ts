/**
 * Annotation Data Exporter & Importer
 * Supports JSON format and XFDF (XML Forms Data Format) for interoperability with Adobe Acrobat.
 */

import { store } from '../core/store';
import { Annotation } from '../core/types';

export class DataExporter {
  public exportToJSON(): string {
    const doc = store.activeDocument;
    if (!doc) throw new Error('No active document');

    const payload = {
      version: '1.0.0',
      generator: 'veditor',
      documentName: doc.name,
      pageCount: doc.pageCount,
      exportedAt: Date.now(),
      annotations: doc.annotations
    };

    return JSON.stringify(payload, null, 2);
  }

  public importFromJSON(jsonString: string): boolean {
    const doc = store.activeDocument;
    if (!doc) return false;

    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.annotations && typeof parsed.annotations === 'object') {
        // Merge or replace annotations
        doc.annotations = { ...doc.annotations, ...parsed.annotations };
        doc.lastModifiedAt = Date.now();
        return true;
      }
    } catch (err) {
      console.error('Failed to import annotations JSON:', err);
    }
    return false;
  }

  public exportToXFDF(): string {
    const doc = store.activeDocument;
    if (!doc) throw new Error('No active document');

    let xfdf = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xfdf += `<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n`;
    xfdf += `  <annots>\n`;

    for (const [pageIdxStr, annotations] of Object.entries(doc.annotations)) {
      const pageIndex = parseInt(pageIdxStr, 10);
      for (const ann of annotations as Annotation[]) {
        const b = ann.box;
        const rectStr = `${b.x.toFixed(2)},${b.y.toFixed(2)},${(b.x + b.width).toFixed(2)},${(b.y + b.height).toFixed(2)}`;

        if (ann.type === 'pen' && ann.points) {
          const gestures = ann.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';');
          xfdf += `    <ink page="${pageIndex}" rect="${rectStr}" color="${ann.color}" width="${ann.strokeWidth}">\n`;
          xfdf += `      <gesture>${gestures}</gesture>\n`;
          xfdf += `    </ink>\n`;
        } else if (ann.type === 'rectangle') {
          xfdf += `    <square page="${pageIndex}" rect="${rectStr}" color="${ann.strokeColor}" width="${ann.strokeWidth}" />\n`;
        } else if (ann.type === 'ellipse') {
          xfdf += `    <circle page="${pageIndex}" rect="${rectStr}" color="${ann.strokeColor}" width="${ann.strokeWidth}" />\n`;
        } else if (ann.type === 'text') {
          xfdf += `    <freetext page="${pageIndex}" rect="${rectStr}" color="${ann.color}">\n`;
          xfdf += `      <contents>${escapeXml(ann.text)}</contents>\n`;
          xfdf += `    </freetext>\n`;
        } else if (ann.type === 'sticky-note') {
          const note = ann as any;
          const txt = (note.texts || []).map((t: any) => t.text).join('\n')
            || ((note.ink || []).length > 0 ? '(handwritten note)' : '(empty note)');
          xfdf += `    <text page="${pageIndex}" rect="${rectStr}" color="#b45309" veditor:id="${note.id}" veditor:collapsed="${note.collapsed ? 1 : 0}">\n`;
          xfdf += `      <contents>${escapeXml(txt)}</contents>\n`;
          xfdf += `    </text>\n`;
        }
      }
    }

    xfdf += `  </annots>\n`;
    xfdf += `</xfdf>\n`;
    return xfdf;
  }
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export const dataExporter = new DataExporter();
