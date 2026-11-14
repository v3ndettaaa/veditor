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
      version: '4.0.0',
      generator: 'veditor',
      documentName: doc.name,
      pageCount: doc.pageCount,
      exportedAt: Date.now(),
      annotations: doc.annotations,
      userBookmarks: doc.userBookmarks || [],
      formValues: doc.formValues || {}
    };

    return JSON.stringify(payload, null, 2);
  }

  public importFromJSON(jsonString: string): boolean {
    const doc = store.activeDocument;
    if (!doc) return false;

    try {
      const parsed = JSON.parse(jsonString);
      let importedAny = false;
      if (parsed.annotations && typeof parsed.annotations === 'object') {
        doc.annotations = { ...doc.annotations, ...parsed.annotations };
        importedAny = true;
      }
      if (Array.isArray(parsed.userBookmarks)) {
        doc.userBookmarks = [...parsed.userBookmarks];
        importedAny = true;
      }
      if (parsed.formValues && typeof parsed.formValues === 'object') {
        doc.formValues = { ...(doc.formValues || {}), ...parsed.formValues };
        importedAny = true;
      }
      if (importedAny) {
        doc.lastModifiedAt = Date.now();
        return true;
      }
    } catch (err) {
      console.error('Failed to import annotations JSON:', err);
    }
    return false;
  }

  public downloadTextFile(content: string, filename: string, mimeType = 'text/plain;charset=utf-8'): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
        const opAttr = typeof ann.opacity === 'number' && ann.opacity < 1 ? ` opacity="${ann.opacity.toFixed(2)}"` : '';

        if ((ann.type === 'pen' || ann.type === 'highlighter') && ann.points && ann.points.length > 0) {
          const gestures = ann.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';');
          xfdf += `    <ink page="${pageIndex}" rect="${rectStr}" color="${escapeXml(ann.color)}" width="${ann.strokeWidth}"${opAttr}>\n`;
          xfdf += `      <gesture>${gestures}</gesture>\n`;
          xfdf += `    </ink>\n`;
        } else if (ann.type === 'rectangle' || ann.type === 'ellipse') {
          const tag = ann.type === 'rectangle' ? 'square' : 'circle';
          const fillAttr = ann.fillColor && ann.fillColor !== 'transparent' ? ` interior-color="${escapeXml(ann.fillColor)}"` : '';
          const effOpacity = (ann.opacity ?? 1) * (ann.fillOpacity ?? 1);
          const shapeOpAttr = effOpacity < 1 ? ` opacity="${effOpacity.toFixed(2)}"` : opAttr;
          xfdf += `    <${tag} page="${pageIndex}" rect="${rectStr}" color="${escapeXml(ann.strokeColor)}" width="${ann.strokeWidth}"${fillAttr}${shapeOpAttr} />\n`;
        } else if ((ann.type === 'line' || ann.type === 'arrow') && ann.points && ann.points.length >= 2) {
          const p0 = ann.points[0];
          const p1 = ann.points[ann.points.length - 1];
          const headAttr = ann.type === 'arrow' || ann.arrowEnd ? ` tail="ClosedArrow"` : '';
          const startAttr = ann.arrowStart ? ` head="ClosedArrow"` : '';
          xfdf += `    <line page="${pageIndex}" rect="${rectStr}" start="${p0.x.toFixed(2)},${p0.y.toFixed(2)}" end="${p1.x.toFixed(2)},${p1.y.toFixed(2)}" color="${escapeXml(ann.strokeColor)}" width="${ann.strokeWidth}"${startAttr}${headAttr}${opAttr} />\n`;
        } else if ((ann.type === 'polygon' || ann.type === 'freeform-shape') && ann.points && ann.points.length >= 3) {
          const vertices = ann.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';');
          const fillAttr = ann.fillColor && ann.fillColor !== 'transparent' ? ` interior-color="${escapeXml(ann.fillColor)}"` : '';
          const effOpacity = (ann.opacity ?? 1) * (ann.fillOpacity ?? 1);
          const shapeOpAttr = effOpacity < 1 ? ` opacity="${effOpacity.toFixed(2)}"` : opAttr;
          xfdf += `    <polygon page="${pageIndex}" rect="${rectStr}" color="${escapeXml(ann.strokeColor)}" width="${ann.strokeWidth}"${fillAttr}${shapeOpAttr}>\n`;
          xfdf += `      <vertices>${vertices}</vertices>\n`;
          xfdf += `    </polygon>\n`;
        } else if (ann.type === 'text') {
          xfdf += `    <freetext page="${pageIndex}" rect="${rectStr}" color="${escapeXml(ann.color)}"${opAttr}>\n`;
          xfdf += `      <contents>${escapeXml(ann.text)}</contents>\n`;
          xfdf += `    </freetext>\n`;
        } else if (ann.type === 'sticky-note') {
          xfdf += `    <text page="${pageIndex}" rect="${rectStr}" color="${escapeXml(ann.color)}" title="${escapeXml(ann.author || '')}"${opAttr}>\n`;
          xfdf += `      <contents>${escapeXml(ann.text || '')}</contents>\n`;
          xfdf += `    </text>\n`;
        } else if (ann.type === 'stamp') {
          xfdf += `    <stamp page="${pageIndex}" rect="${rectStr}" subject="${escapeXml(ann.presetKey || 'Custom')}"${opAttr} />\n`;
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
