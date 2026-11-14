/**
 * Lightweight pure-TypeScript ZIP archive builder (STORE / method 0 with IEEE 802.3 CRC-32).
 * Used to bundle multi-page PNG/JPEG exports into a single downloadable `.zip` file.
 */

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
  modifiedAt?: Date;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function sanitizeZipEntryName(name: string, index: number): string {
  const cleaned = String(name || '')
    .replace(/^[/\\]+/, '')
    .replace(/\.\.(\/|\\|$)/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  return cleaned || `page-${index + 1}.bin`;
}

/**
 * Builds an uncompressed (STORE) ZIP archive byte buffer with UTF-8 filename flags.
 */
export function buildZipArchive(entries: ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fileName = sanitizeZipEntryName(entry.name, i);
    const nameBytes = encoder.encode(fileName);
    const data = entry.data;
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(entry.modifiedAt ?? now);

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true); // Local file header signature
    ldv.setUint16(4, 20, true);         // Version needed (2.0)
    ldv.setUint16(6, 0x0800, true);     // UTF-8 filename flag (bit 11)
    ldv.setUint16(8, 0, true);          // Compression method: 0 = STORE
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    // Central directory header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(centralHeader.buffer);
    cdv.setUint32(0, 0x02014b50, true); // Central directory signature
    cdv.setUint16(4, 20, true);         // Version made by
    cdv.setUint16(6, 20, true);         // Version needed
    cdv.setUint16(8, 0x0800, true);     // UTF-8 flag
    cdv.setUint16(10, 0, true);         // Compression method: 0 = STORE
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);         // Extra length
    cdv.setUint16(32, 0, true);         // File comment length
    cdv.setUint16(34, 0, true);         // Disk number start
    cdv.setUint16(36, 0, true);         // Internal file attributes
    cdv.setUint32(38, 0, true);         // External file attributes
    cdv.setUint32(42, offset, true);    // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    centralSize += centralHeader.length;
    offset += localHeader.length + data.length;
  }

  // End of Central Directory (22 bytes)
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalLength = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

export function buildZipBlob(entries: ZipEntryInput[]): Blob {
  const bytes = buildZipArchive(entries);
  return new Blob([bytes as any], { type: 'application/zip' });
}
