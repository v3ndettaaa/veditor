/**
 * Lightweight pure-TypeScript ZIP archive builder (STORE / method 0 with IEEE 802.3 CRC-32)
 * with optional PKWARE Traditional ZipCrypto password encryption (flag 0x0001).
 * Used to bundle single or multi-page PNG/JPEG/XFDF exports into downloadable `.zip` files.
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

function crc32Step(crc: number, byte: number): number {
  return (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

class ZipCryptoCipher {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(passwordBytes: Uint8Array) {
    for (let i = 0; i < passwordBytes.length; i++) {
      this.updateKeys(passwordBytes[i]);
    }
  }

  private updateKeys(byte: number): void {
    this.k0 = crc32Step(this.k0, byte);
    this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
    this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
    this.k2 = crc32Step(this.k2, (this.k1 >>> 24) & 0xff);
  }

  private keystreamByte(): number {
    const temp = (this.k2 & 0xffff) | 2;
    return (((temp * (temp ^ 1)) >>> 8) & 0xff);
  }

  public encryptByte(plainByte: number): number {
    const out = plainByte ^ this.keystreamByte();
    this.updateKeys(plainByte);
    return out;
  }

  public decryptByte(cipherByte: number): number {
    const plain = cipherByte ^ this.keystreamByte();
    this.updateKeys(plain);
    return plain;
  }
}

function fillRandomBytes(target: Uint8Array): void {
  const gCrypto = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (gCrypto && typeof gCrypto.getRandomValues === 'function') {
    gCrypto.getRandomValues(target);
    return;
  }
  for (let i = 0; i < target.length; i++) {
    target[i] = Math.floor(Math.random() * 256) & 0xff;
  }
}

/**
 * Encrypts one ZIP entry payload using PKWARE Traditional ZipCrypto (12-byte verification header + data).
 */
export function encryptZipCryptoPayload(data: Uint8Array, crc: number, password: string): Uint8Array {
  const pwdBytes = new TextEncoder().encode(password);
  const cipher = new ZipCryptoCipher(pwdBytes);
  const header = new Uint8Array(12);
  fillRandomBytes(header.subarray(0, 11));
  header[11] = (crc >>> 24) & 0xff;

  const out = new Uint8Array(12 + data.length);
  for (let i = 0; i < 12; i++) {
    out[i] = cipher.encryptByte(header[i]);
  }
  for (let i = 0; i < data.length; i++) {
    out[12 + i] = cipher.encryptByte(data[i]);
  }
  return out;
}

/**
 * Decrypts a ZipCrypto-encrypted STORE entry payload and verifies the header check byte + CRC-32.
 */
export function decryptZipCryptoEntry(encryptedPayload: Uint8Array, expectedCrc: number, password: string): Uint8Array {
  if (encryptedPayload.length < 12) {
    throw new Error('Encrypted ZIP payload too short');
  }
  const pwdBytes = new TextEncoder().encode(password);
  const cipher = new ZipCryptoCipher(pwdBytes);
  let lastHeaderByte = 0;
  for (let i = 0; i < 12; i++) {
    lastHeaderByte = cipher.decryptByte(encryptedPayload[i]);
  }
  const expectedCheckByte = (expectedCrc >>> 24) & 0xff;
  if (lastHeaderByte !== expectedCheckByte) {
    throw new Error('Invalid ZIP password');
  }
  const plain = new Uint8Array(encryptedPayload.length - 12);
  for (let i = 0; i < plain.length; i++) {
    plain[i] = cipher.decryptByte(encryptedPayload[12 + i]);
  }
  if (crc32(plain) !== (expectedCrc >>> 0)) {
    throw new Error('ZIP CRC mismatch');
  }
  return plain;
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
 * Builds an uncompressed (STORE) ZIP archive byte buffer with UTF-8 filename flags
 * and optional ZipCrypto password encryption.
 */
export function buildZipArchive(entries: ZipEntryInput[], password?: string): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const hasPassword = typeof password === 'string' && password.length > 0;
  const gpFlags = hasPassword ? (0x0800 | 0x0001) : 0x0800;
  let offset = 0;
  let centralSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fileName = sanitizeZipEntryName(entry.name, i);
    const nameBytes = encoder.encode(fileName);
    const plainData = entry.data;
    const crc = crc32(plainData);
    const payload = hasPassword ? encryptZipCryptoPayload(plainData, crc, password!) : plainData;
    const { dosTime, dosDate } = dosDateTime(entry.modifiedAt ?? now);

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true); // Local file header signature
    ldv.setUint16(4, 20, true);         // Version needed (2.0)
    ldv.setUint16(6, gpFlags, true);    // UTF-8 filename flag (bit 11) + optional ZipCrypto flag (bit 0)
    ldv.setUint16(8, 0, true);          // Compression method: 0 = STORE
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, payload.length, true);   // Compressed size (includes 12-byte ZipCrypto header when encrypted)
    ldv.setUint32(22, plainData.length, true); // Uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);         // Extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(centralHeader.buffer);
    cdv.setUint32(0, 0x02014b50, true); // Central directory signature
    cdv.setUint16(4, 20, true);         // Version made by
    cdv.setUint16(6, 20, true);         // Version needed
    cdv.setUint16(8, gpFlags, true);    // UTF-8 + optional ZipCrypto flag
    cdv.setUint16(10, 0, true);         // Compression method: 0 = STORE
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, payload.length, true);
    cdv.setUint32(24, plainData.length, true);
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
    offset += localHeader.length + payload.length;
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

export function buildZipBlob(entries: ZipEntryInput[], password?: string): Blob {
  const bytes = buildZipArchive(entries, password);
  return new Blob([bytes as any], { type: 'application/zip' });
}
