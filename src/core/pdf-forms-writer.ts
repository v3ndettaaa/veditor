import { PDFName, type PDFDocument } from 'pdf-lib';

/**
 * Writes `formValues` (text, checkbox, radio group, dropdown) into a `pdf-lib`
 * PDFDocument during Save / Save As, optionally flattening fields into page content.
 * Returns `true` if any AcroForm fields were modified.
 */
export function applyFormValuesToPdfLibDoc(
  pdfDoc: PDFDocument,
  formValues?: Record<string, string | boolean>,
  flatten: boolean = false
): boolean {
  const hasValues = Boolean(formValues && Object.keys(formValues).length > 0);
  if (!hasValues && !flatten) return false;
  let modified = false;
  try {
    if (!pdfDoc.catalog.has(PDFName.of('AcroForm'))) return false;
    const form = pdfDoc.getForm();
    if (hasValues && formValues) {
      for (const [fieldName, value] of Object.entries(formValues)) {
        if (value === undefined) continue;
        try {
          const field = form.getFieldMaybe(fieldName);
          if (!field) continue;
          const ctorName = field.constructor?.name || '';
          if (ctorName === 'PDFTextField' || typeof (field as any).setText === 'function') {
            (field as any).setText(String(value));
            modified = true;
          } else if (ctorName === 'PDFCheckBox' || typeof (field as any).check === 'function') {
            if (value) (field as any).check();
            else (field as any).uncheck?.();
            modified = true;
          } else if (
            ctorName === 'PDFDropdown' ||
            ctorName === 'PDFRadioGroup' ||
            typeof (field as any).select === 'function'
          ) {
            if (value) (field as any).select(String(value));
            modified = true;
          }
        } catch (_) {
          // Ignore individual unsupported or read-only fields
        }
      }
    }
    if (flatten && form.getFields().length > 0) {
      try {
        form.flatten({ updateFieldAppearances: modified });
      } catch (_) {
        try {
          form.flatten({ updateFieldAppearances: false });
        } catch (_) {
          // Malformed AcroForm — keep original fields intact rather than corrupting page xref
        }
      }
    }
  } catch (_) {
    // Document has no AcroForm dictionary
  }
  return modified;
}
