import type { PDFDocument } from 'pdf-lib';

/**
 * Writes `formValues` (text, checkbox, radio group, dropdown) into a `pdf-lib`
 * PDFDocument during Save / Save As, optionally flattening fields into page content.
 */
export function applyFormValuesToPdfLibDoc(
  pdfDoc: PDFDocument,
  formValues?: Record<string, string | boolean>,
  flatten: boolean = false
): void {
  if (!formValues || Object.keys(formValues).length === 0) return;
  try {
    const form = pdfDoc.getForm();
    for (const [fieldName, value] of Object.entries(formValues)) {
      if (value === undefined) continue;
      try {
        const field = form.getFieldMaybe(fieldName);
        if (!field) continue;
        const ctorName = field.constructor?.name || '';
        if (ctorName === 'PDFTextField' || typeof (field as any).setText === 'function') {
          (field as any).setText(String(value));
        } else if (ctorName === 'PDFCheckBox' || typeof (field as any).check === 'function') {
          if (value) (field as any).check();
          else (field as any).uncheck?.();
        } else if (
          ctorName === 'PDFDropdown' ||
          ctorName === 'PDFRadioGroup' ||
          typeof (field as any).select === 'function'
        ) {
          if (value) (field as any).select(String(value));
        }
      } catch (_) {
        // Ignore individual unsupported or read-only fields
      }
    }
    if (flatten) {
      try {
        form.flatten();
      } catch (_) {}
    }
  } catch (_) {
    // Document has no AcroForm dictionary
  }
}
