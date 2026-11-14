export type PrintPagesPerSheet = 1 | 2 | 4;

/**
 * Parses a human-readable 1-based page range string like "1-3, 5, 8-10"
 * into sorted, unique 0-based page indices clamped to [0, pageCount - 1].
 */
export function parsePrintPageRange(raw: string, pageCount: number): number[] {
  if (pageCount <= 0) return [];
  const indices = new Set<number>();
  const parts = String(raw || '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const start = Math.max(1, Math.min(pageCount, Math.min(a, b)));
      const end = Math.max(1, Math.min(pageCount, Math.max(a, b)));
      for (let p = start; p <= end; p++) {
        indices.add(p - 1);
      }
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= pageCount) {
        indices.add(p - 1);
      }
    }
  }

  return [...indices].sort((a, b) => a - b);
}

/** Groups page indices into physical paper sheets for 1-up, 2-up, or 4-up printing. */
export function groupPagesIntoSheets(
  pageIndices: number[],
  pagesPerSheet: PrintPagesPerSheet
): number[][] {
  if (pageIndices.length === 0) return [];
  const perSheet = pagesPerSheet === 2 ? 2 : pagesPerSheet === 4 ? 4 : 1;
  const sheets: number[][] = [];
  for (let i = 0; i < pageIndices.length; i += perSheet) {
    sheets.push(pageIndices.slice(i, i + perSheet));
  }
  return sheets;
}

/**
 * Fast, non-allocating check on PDF header/trailer windows to detect whether
 * the file likely carries an `/Encrypt` dictionary before rendering a loading skeleton.
 */
export function pdfBytesMayBeEncrypted(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 16) return false;
  const needle = '/Encrypt';
  const matchesAt = (start: number, end: number): boolean => {
    const limit = Math.min(end, bytes.length) - needle.length;
    for (let i = Math.max(0, start); i <= limit; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  // Standard PDFs put /Encrypt in the tail trailer; linearized PDFs may put it near the head.
  if (matchesAt(Math.max(0, bytes.length - 32768), bytes.length)) return true;
  return matchesAt(0, Math.min(bytes.length, 8192));
}

/** Classifies PDF.js missing/wrong password errors cleanly. */
export function isPdfPasswordError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'PasswordException') return true;
  // pdfjs-dist PasswordResponses: NEED_PASSWORD = 1, INCORRECT_PASSWORD = 2
  if (e.code === 1 || e.code === 2) return true;
  return /password/i.test(String(e.message || ''));
}

/** Builds scoped `@page` styling for native browser printing. */
export function buildPrintPageCss(isLandscape: boolean, darkPaper: boolean): string {
  return `@page { margin: 0; ${isLandscape ? 'size: landscape;' : 'size: portrait;'} }
@media print {
  html, body {
    background: ${darkPaper ? '#111318' : '#ffffff'} !important;
  }
}`;
}

