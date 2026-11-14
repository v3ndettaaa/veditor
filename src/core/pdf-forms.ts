/**
 * Interactive PDF Form Filling (AcroForm Widget Support)
 * Extracts fillable PDF Widget annotations (text inputs, checkboxes, radio buttons,
 * dropdowns), renders interactive HTML form controls over each page, persists
 * values in `doc.formValues`, and bakes/writes values on Save, Export, and Print.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { store } from './store';
import { pdfEngine } from './pdf-engine';
import { applyFormValuesToPdfLibDoc } from './pdf-forms-writer';

export { applyFormValuesToPdfLibDoc };

export interface PDFFormFieldItem {
  id: string;
  fieldName: string;
  fieldType: 'Tx' | 'Btn' | 'Ch';
  pageIndex: number;
  /** Normalized [0..1] rectangle relative to the rotated page viewport. */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  defaultValue?: string | boolean;
  multiLine?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  radioValue?: string;
  options?: Array<{ value: string; label: string }>;
  readOnly?: boolean;
}

const formFieldsCache = new Map<string, Map<number, PDFFormFieldItem[]>>();

export function clearFormFieldsCache(docId?: string): void {
  if (docId) formFieldsCache.delete(docId);
  else formFieldsCache.clear();
}

/**
 * Extracts fillable AcroForm Widget fields for a given page and rotation.
 */
export async function getPageFormFields(
  pageIndex: number,
  extraRotation: number = 0
): Promise<PDFFormFieldItem[]> {
  const doc = store.activeDocument;
  const pdfDoc = pdfEngine.pdfDocument;
  if (!doc || !pdfDoc) return [];

  const cacheKey = `${doc.id}:${extraRotation}`;
  let docMap = formFieldsCache.get(cacheKey);
  if (!docMap) {
    docMap = new Map();
    formFieldsCache.set(cacheKey, docMap);
  }
  const cached = docMap.get(pageIndex);
  if (cached) return cached;

  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const totalRotation = (page.rotate + extraRotation) % 360;
    const viewport = page.getViewport({ scale: 1.0, rotation: totalRotation });
    const rawAnns = await page.getAnnotations({ intent: 'display' });
    const fields: PDFFormFieldItem[] = [];

    for (let i = 0; i < rawAnns.length; i++) {
      const a = rawAnns[i] as any;
      if (a?.subtype !== 'Widget') continue;
      const ft = a.fieldType as string | undefined;
      if (ft !== 'Tx' && ft !== 'Btn' && ft !== 'Ch') continue;
      if (!Array.isArray(a.rect) || a.rect.length < 4) continue;

      let vx1 = a.rect[0], vy1 = a.rect[1], vx2 = a.rect[2], vy2 = a.rect[3];
      if (typeof viewport.convertToViewportPoint === 'function') {
        const p1 = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        const p2 = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
        vx1 = p1[0];
        vy1 = p1[1];
        vx2 = p2[0];
        vy2 = p2[1];
      } else if (typeof (viewport as any).convertToViewportRectangle === 'function') {
        const r = (viewport as any).convertToViewportRectangle(a.rect);
        vx1 = r[0];
        vy1 = r[1];
        vx2 = r[2];
        vy2 = r[3];
      } else {
        vy1 = viewport.height - a.rect[1];
        vy2 = viewport.height - a.rect[3];
      }
      const x1 = Math.max(0, Math.min(viewport.width, Math.min(vx1, vx2)));
      const y1 = Math.max(0, Math.min(viewport.height, Math.min(vy1, vy2)));
      const x2 = Math.max(0, Math.min(viewport.width, Math.max(vx1, vx2)));
      const y2 = Math.max(0, Math.min(viewport.height, Math.max(vy1, vy2)));
      const w = x2 - x1;
      const h = y2 - y1;
      if (w < 4 || h < 4) continue;

      const fieldName = String(a.fieldName || a.id || `field_${pageIndex}_${i}`);
      const id = String(a.id || `${fieldName}_${i}`);
      const isCheck = Boolean(a.checkBox);
      const isRadio = Boolean(a.radioButton);
      if (ft === 'Btn' && !isCheck && !isRadio) continue; // skip push buttons

      let defaultVal: string | boolean = '';
      if (ft === 'Btn') {
        if (isCheck) {
          defaultVal = Boolean(a.fieldValue && a.fieldValue !== 'Off');
        } else if (isRadio) {
          defaultVal = String(a.fieldValue || '');
        }
      } else if (Array.isArray(a.fieldValue)) {
        defaultVal = typeof a.fieldValue[0] === 'string' ? a.fieldValue[0] : '';
      } else {
        defaultVal = typeof a.fieldValue === 'string' ? a.fieldValue : '';
      }

      const options = Array.isArray(a.options)
        ? a.options.map((o: any) => ({
            value: String(o?.exportValue ?? o?.displayValue ?? ''),
            label: String(o?.displayValue ?? o?.exportValue ?? '')
          }))
        : undefined;

      fields.push({
        id,
        fieldName,
        fieldType: ft,
        pageIndex,
        nx: x1 / Math.max(1, viewport.width),
        ny: y1 / Math.max(1, viewport.height),
        nw: w / Math.max(1, viewport.width),
        nh: h / Math.max(1, viewport.height),
        defaultValue: defaultVal,
        multiLine: Boolean(a.multiLine),
        checkBox: isCheck,
        radioButton: isRadio,
        radioValue: String(a.buttonValue ?? a.exportValue ?? id),
        options,
        readOnly: Boolean(a.readOnly)
      });
    }

    docMap.set(pageIndex, fields);
    return fields;
  } catch (err) {
    console.warn(`Failed to extract form fields for page ${pageIndex + 1}:`, err);
    return [];
  }
}

/**
 * Mounts interactive HTML inputs for any AcroForm fields on `pageIndex` inside `hostLayer`.
 */
export function mountPageFormFields(
  hostLayer: HTMLElement,
  pageIndex: number,
  fields: PDFFormFieldItem[],
  onFieldChange?: () => void
): void {
  hostLayer.querySelectorAll('.pdf-form-widget').forEach(el => el.remove());
  const doc = store.activeDocument;
  if (!doc || fields.length === 0) return;

  if (!doc.formValues) doc.formValues = {};
  const formValues = doc.formValues;

  for (const field of fields) {
    const key = field.fieldName || field.id;
    if (formValues[key] === undefined && field.defaultValue !== undefined && field.defaultValue !== '') {
      formValues[key] = field.defaultValue;
    }

    const wrap = document.createElement('div');
    wrap.className = 'pdf-form-widget';
    wrap.style.position = 'absolute';
    wrap.style.left = `${(field.nx * 100).toFixed(3)}%`;
    wrap.style.top = `${(field.ny * 100).toFixed(3)}%`;
    wrap.style.width = `${(field.nw * 100).toFixed(3)}%`;
    wrap.style.height = `${(field.nh * 100).toFixed(3)}%`;
    wrap.style.pointerEvents = 'auto';
    wrap.style.zIndex = '6';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';

    // Stop pointer events from starting pen/shape strokes underneath when clicking a form field
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.addEventListener('click', (e) => e.stopPropagation());

    if (field.fieldType === 'Tx') {
      const inp = field.multiLine
        ? document.createElement('textarea')
        : document.createElement('input');
      if (!field.multiLine) (inp as HTMLInputElement).type = 'text';
      inp.value = String(formValues[key] ?? '');
      inp.disabled = Boolean(field.readOnly);
      inp.setAttribute('aria-label', field.fieldName || `Form field page ${pageIndex + 1}`);
      inp.style.width = '100%';
      inp.style.height = '100%';
      inp.style.padding = '2px 5px';
      inp.style.border = '1px solid rgba(79, 70, 229, 0.42)';
      inp.style.borderRadius = '3px';
      inp.style.background = '#f3f5ff';
      inp.style.color = '#0f172a';
      inp.style.fontSize = '12px';
      inp.style.fontFamily = 'inherit';
      inp.style.outline = 'none';
      inp.style.resize = 'none';
      inp.addEventListener('focus', () => {
        inp.style.background = 'rgba(255, 255, 255, 0.95)';
        inp.style.borderColor = '#4f46e5';
        inp.style.boxShadow = '0 0 0 2px rgba(79, 70, 229, 0.22)';
      });
      inp.addEventListener('blur', () => {
        inp.style.background = '#f3f5ff';
        inp.style.borderColor = 'rgba(79, 70, 229, 0.42)';
        inp.style.boxShadow = 'none';
      });
      inp.addEventListener('input', () => {
        if (!doc.formValues) doc.formValues = {};
        doc.formValues[key] = inp.value;
        doc.lastModifiedAt = Date.now();
        onFieldChange?.();
      });
      wrap.appendChild(inp);
    } else if (field.fieldType === 'Btn') {
      const inp = document.createElement('input');
      inp.type = field.radioButton ? 'radio' : 'checkbox';
      inp.disabled = Boolean(field.readOnly);
      inp.name = field.radioButton ? `pdf_radio_${doc.id}_${field.fieldName}` : field.id;
      if (field.radioButton) {
        inp.checked = String(formValues[key] ?? '') === String(field.radioValue ?? '');
      } else {
        inp.checked = Boolean(formValues[key]);
      }
      inp.style.width = '100%';
      inp.style.height = '100%';
      inp.style.margin = '0';
      inp.style.cursor = 'pointer';
      inp.style.accentColor = '#4f46e5';
      inp.addEventListener('change', () => {
        if (!doc.formValues) doc.formValues = {};
        if (field.radioButton) {
          if (inp.checked) doc.formValues[key] = String(field.radioValue ?? inp.value);
        } else {
          doc.formValues[key] = inp.checked;
        }
        doc.lastModifiedAt = Date.now();
        onFieldChange?.();
      });
      wrap.appendChild(inp);
    } else if (field.fieldType === 'Ch' && field.options) {
      const sel = document.createElement('select');
      sel.disabled = Boolean(field.readOnly);
      sel.style.width = '100%';
      sel.style.height = '100%';
      sel.style.border = '1px solid rgba(79, 70, 229, 0.42)';
      sel.style.borderRadius = '3px';
      sel.style.background = '#f3f5ff';
      sel.style.color = '#0f172a';
      sel.style.fontSize = '12px';
      for (const opt of field.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = String(formValues[key] ?? '');
      sel.addEventListener('change', () => {
        if (!doc.formValues) doc.formValues = {};
        doc.formValues[key] = sel.value;
        doc.lastModifiedAt = Date.now();
        onFieldChange?.();
      });
      wrap.appendChild(sel);
    }

    hostLayer.appendChild(wrap);
  }
}

/**
 * Paints filled AcroForm values onto a canvas (for PNG/JPEG image export and printing).
 */
export async function renderPageFormValuesToCanvas(
  ctx: CanvasRenderingContext2D,
  pageIndex: number,
  scale: number,
  extraRotation: number = 0
): Promise<void> {
  const doc = store.activeDocument;
  if (!doc?.formValues || Object.keys(doc.formValues).length === 0) return;
  const fields = await getPageFormFields(pageIndex, extraRotation);
  if (fields.length === 0) return;

  const pageMeta = doc.pages[pageIndex];
  if (!pageMeta) return;
  const isRotated90or270 = extraRotation % 180 !== 0;
  const pageW = isRotated90or270 ? pageMeta.height : pageMeta.width;
  const pageH = isRotated90or270 ? pageMeta.width : pageMeta.height;

  ctx.save();
  ctx.scale(scale, scale);

  for (const field of fields) {
    const key = field.fieldName || field.id;
    const val = doc.formValues[key];
    if (val === undefined || val === '' || val === false) continue;

    const x = field.nx * pageW;
    const y = field.ny * pageH;
    const w = field.nw * pageW;
    const h = field.nh * pageH;

    if (field.fieldType === 'Btn') {
      if (field.radioButton && String(val) !== String(field.radioValue)) continue;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h * 0.55);
      ctx.lineTo(x + w * 0.42, y + h * 0.78);
      ctx.lineTo(x + w * 0.8, y + h * 0.24);
      ctx.stroke();
    } else {
      const text = String(val);
      const fontSize = Math.max(9, Math.min(14, h * 0.62));
      ctx.fillStyle = '#0f172a';
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 4, y + h / 2, Math.max(10, w - 8));
    }
  }

  ctx.restore();
}
