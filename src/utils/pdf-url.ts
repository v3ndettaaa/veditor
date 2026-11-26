/**
 * Pure URL & PDF binary header helpers for opening web PDFs directly in veditor.
 */

const VIEWER_PARAM_KEYS = ['pdfUrl', 'file', 'src', 'url', 'pdf'];

/**
 * Unwraps browser built-in PDF viewer wrapper URLs (Chrome/Edge PDF viewer,
 * Firefox PDF.js viewer, Google viewer, or double-encoded query parameters)
 * to recover the direct underlying PDF URL.
 */
export function resolveWebPdfUrl(rawUrl: string, baseHref?: string): string {
  let current = (rawUrl || '').trim();
  if (!current) return '';

  // Try up to 3 unwrapping passes (handles nested viewer / redirect wrappers)
  for (let pass = 0; pass < 3; pass++) {
    try {
      const parsed = baseHref ? new URL(current, baseHref) : new URL(current);
      let unwrapped: string | null = null;

      for (const key of VIEWER_PARAM_KEYS) {
        const val = parsed.searchParams.get(key);
        if (val && /^(https?:\/\/|file:\/\/|blob:)/i.test(val.trim())) {
          unwrapped = val.trim();
          break;
        }
      }

      // Some wrappers place the target URL in the hash (e.g. #file=https://...)
      if (!unwrapped && parsed.hash && parsed.hash.length > 2) {
        const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
        for (const key of VIEWER_PARAM_KEYS) {
          const val = hashParams.get(key);
          if (val && /^(https?:\/\/|file:\/\/|blob:)/i.test(val.trim())) {
            unwrapped = val.trim();
            break;
          }
        }
      }

      if (unwrapped && unwrapped !== current) {
        current = unwrapped;
        continue;
      }
      return parsed.href;
    } catch {
      // Try one decodeURIComponent if the raw URL was percent-encoded
      try {
        const decoded = decodeURIComponent(current);
        if (decoded !== current && /^(https?:\/\/|file:\/\/|blob:)/i.test(decoded)) {
          current = decoded;
          continue;
        }
      } catch {
        // ignore malformed escape
      }
      return current;
    }
  }
  return current;
}

/**
 * Extracts a clean `.pdf` filename from a URL, stripping query strings and hashes.
 */
export function extractCleanPdfFilename(urlStr: string, baseHref?: string): string {
  try {
    const u = baseHref ? new URL(urlStr, baseHref) : new URL(urlStr);
    const rawSeg = u.pathname.split('/').filter(Boolean).pop() || 'document.pdf';
    const decoded = decodeURIComponent(rawSeg).replace(/[?#].*$/, '').trim();
    if (!decoded) return 'document.pdf';
    return decoded.toLowerCase().endsWith('.pdf') ? decoded : `${decoded}.pdf`;
  } catch {
    const fallback = (urlStr || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'document.pdf';
    return fallback.toLowerCase().endsWith('.pdf') ? fallback : `${fallback}.pdf`;
  }
}

/**
 * Returns true if `url` is a direct `http(s)` URL that points to a PDF resource
 * (either ending in `.pdf` or matching well-known direct PDF endpoints like arXiv).
 */
export function isLikelyWebPdfUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const cleanPath = url.split(/[?#]/)[0];
  if (/\.pdf$/i.test(cleanPath)) return true;
  // Common direct PDF endpoints without a .pdf suffix (e.g. https://arxiv.org/pdf/2401.12345)
  if (/^https?:\/\/(?:www\.)?arxiv\.org\/pdf\/[^/?#]+$/i.test(cleanPath)) return true;
  return false;
}

/**
 * Scans the leading bytes of a fetched buffer (up to 1024 bytes per PDF spec §7.5.2)
 * for the `%PDF-` signature. Returns the byte offset if found, or -1 otherwise.
 */
export function findPdfHeaderOffset(bytes: Uint8Array): number {
  if (!bytes || bytes.length < 5) return -1;
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Normalizes a fetched PDF byte array by stripping any leading garbage/BOM bytes
 * before `%PDF-`. Returns `null` if no valid PDF header exists in the first 1024 bytes.
 */
export function normalizePdfBytes(bytes: Uint8Array): Uint8Array | null {
  const offset = findPdfHeaderOffset(bytes);
  if (offset < 0) return null;
  return offset === 0 ? bytes : bytes.subarray(offset);
}

/**
 * Encodes a Uint8Array to base64 in chunks (safe for multi-MB PDFs across extension IPC).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

/**
 * Decodes a base64 string back into a Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
