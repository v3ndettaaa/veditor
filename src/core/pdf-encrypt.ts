/**
 * Standard ISO 32000-1 PDF RC4-128 Encryption (/Filter /Standard /V 2 /R 3 /Length 128).
 * Encrypts pdf-lib documents client-side so Save As can output password-protected PDFs
 * readable by pdf.js and all compliant desktop/mobile PDF viewers.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString
} from 'pdf-lib';

// Standard 32-byte PDF padding string (ISO 32000-1 Section 7.6.3.3 Algorithm 2)
const PDF_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

function padPdfPassword(pwd: string): Uint8Array {
  const encoder = new TextEncoder();
  const raw = encoder.encode(pwd || '');
  const out = new Uint8Array(32);
  const copyLen = Math.min(32, raw.length);
  out.set(raw.subarray(0, copyLen), 0);
  if (copyLen < 32) {
    out.set(PDF_PADDING.subarray(0, 32 - copyLen), copyLen);
  }
  return out;
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }
  return k;
})();

function rotl32(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

export function md5Bytes(input: Uint8Array): Uint8Array {
  const origLen = input.length;
  const paddedLen = (((origLen + 8) >>> 6) + 1) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(input, 0);
  msg[origLen] = 0x80;

  const bitLen = origLen * 8;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLen; offset += 64) {
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const mWord = dv.getUint32(offset + g * 4, true);
      const sum = (A + F + MD5_K[i] + mWord) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(sum, MD5_SHIFTS[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function decodePdfStringBytes(strObj: PDFString | PDFHexString): Uint8Array {
  if (strObj instanceof PDFHexString) {
    let hex = strObj.asString().replace(/\s+/g, '');
    if (hex.length % 2 === 1) hex += '0';
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return bytes;
  }
  return strObj.asBytes();
}

function computeOwnerEntryR3(userPwd: string, ownerPwd: string): Uint8Array {
  const paddedOwner = padPdfPassword(ownerPwd || userPwd);
  let hash = md5Bytes(paddedOwner);
  for (let i = 0; i < 50; i++) {
    hash = md5Bytes(hash.subarray(0, 16));
  }
  const rc4Key = hash.subarray(0, 16);
  let enc = rc4(rc4Key, padPdfPassword(userPwd));
  for (let iter = 1; iter <= 19; iter++) {
    const iterKey = new Uint8Array(16);
    for (let j = 0; j < 16; j++) iterKey[j] = rc4Key[j] ^ iter;
    enc = rc4(iterKey, enc);
  }
  return enc;
}

function computeFileEncryptionKeyR3(
  userPwd: string,
  ownerEntry: Uint8Array,
  permissions: number,
  fileId: Uint8Array
): Uint8Array {
  const permBytes = new Uint8Array(4);
  new DataView(permBytes.buffer).setInt32(0, permissions, true);
  let digest = md5Bytes(concatBytes(padPdfPassword(userPwd), ownerEntry, permBytes, fileId));
  for (let i = 0; i < 50; i++) {
    digest = md5Bytes(digest.subarray(0, 16));
  }
  return digest.subarray(0, 16);
}

function computeUserEntryR3(fileKey: Uint8Array, fileId: Uint8Array): Uint8Array {
  const hash = md5Bytes(concatBytes(PDF_PADDING, fileId));
  let enc = rc4(fileKey, hash);
  for (let iter = 1; iter <= 19; iter++) {
    const iterKey = new Uint8Array(fileKey.length);
    for (let j = 0; j < fileKey.length; j++) iterKey[j] = fileKey[j] ^ iter;
    enc = rc4(iterKey, enc);
  }
  // ISO 32000-1 R=3 appends 16 arbitrary padding bytes to reach 32 bytes
  return concatBytes(enc, PDF_PADDING.subarray(0, 16));
}

function deriveObjectKey(fileKey: Uint8Array, objectNumber: number, generationNumber: number): Uint8Array {
  const suffix = new Uint8Array([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    generationNumber & 0xff,
    (generationNumber >> 8) & 0xff
  ]);
  const digest = md5Bytes(concatBytes(fileKey, suffix));
  return digest.subarray(0, 16);
}

function encryptNestedStrings(obj: any, objKey: Uint8Array, doc: PDFDocument): any {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const plain = decodePdfStringBytes(obj);
    return PDFHexString.of(bytesToHex(rc4(objKey, plain)));
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const item = obj.get(i);
      if (item instanceof PDFRef) continue;
      const replacement = encryptNestedStrings(item, objKey, doc);
      if (replacement !== item) {
        obj.set(i, replacement);
      }
    }
    return obj;
  }
  if (obj instanceof PDFDict) {
    const entries = obj.entries();
    for (const [key, val] of entries) {
      if (val instanceof PDFRef) continue;
      const replacement = encryptNestedStrings(val, objKey, doc);
      if (replacement !== val) {
        obj.set(key, replacement);
      }
    }
    return obj;
  }
  return obj;
}

/**
 * Encrypts all strings and streams inside `pdfDoc` with RC4-128 Standard Security (/V 2 /R 3)
 * and serializes the encrypted PDF bytes cleanly (`useObjectStreams: false`).
 */
export async function encryptAndSavePdfDocument(
  pdfDoc: PDFDocument,
  userPassword: string,
  ownerPassword?: string
): Promise<Uint8Array> {
  if (!userPassword) {
    return pdfDoc.save();
  }

  // Generate 16-byte File ID (random crypto bytes if available)
  const fileId = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(fileId);
  } else {
    for (let i = 0; i < 16; i++) fileId[i] = Math.floor(Math.random() * 256);
  }

  // Standard PDF permission flags: allow print (bit 3 = 4), copy (bit 5 = 16), modify/annot (bit 4+6) -> -4 or -3904
  // -4 guarantees bits 3..12 enabled (full interactive capabilities once unlocked).
  const permissions = -4;
  const effectiveOwner = ownerPassword && ownerPassword.length > 0 ? ownerPassword : userPassword;
  const oEntry = computeOwnerEntryR3(userPassword, effectiveOwner);
  const fileKey = computeFileEncryptionKeyR3(userPassword, oEntry, permissions, fileId);
  const uEntry = computeUserEntryR3(fileKey, fileId);

  const encryptDict = pdfDoc.context.obj({
    Filter: PDFName.of('Standard'),
    V: PDFNumber.of(2),
    R: PDFNumber.of(3),
    Length: PDFNumber.of(128),
    P: PDFNumber.of(permissions),
    O: PDFHexString.of(bytesToHex(oEntry)),
    U: PDFHexString.of(bytesToHex(uEntry))
  });
  const encryptRef = pdfDoc.context.register(encryptDict);

  const indirectObjects = pdfDoc.context.enumerateIndirectObjects();
  for (const [ref, obj] of indirectObjects) {
    if (ref.objectNumber === encryptRef.objectNumber && ref.generationNumber === encryptRef.generationNumber) {
      continue;
    }

    const objKey = deriveObjectKey(fileKey, ref.objectNumber, ref.generationNumber);

    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      const plain = decodePdfStringBytes(obj);
      pdfDoc.context.assign(ref, PDFHexString.of(bytesToHex(rc4(objKey, plain))));
    } else if (obj instanceof PDFStream) {
      // Do not encrypt XRef / ObjStm helper streams if present
      const typeVal = obj.dict.get(PDFName.of('Type'));
      if (typeVal instanceof PDFName && (typeVal === PDFName.of('XRef') || typeVal === PDFName.of('ObjStm'))) {
        continue;
      }
      encryptNestedStrings(obj.dict, objKey, pdfDoc);
      const rawContents = obj.getContents();
      const encryptedContents = rc4(objKey, rawContents);
      const encryptedStream = PDFRawStream.of(obj.dict, encryptedContents);
      pdfDoc.context.assign(ref, encryptedStream);
    } else if (obj instanceof PDFDict || obj instanceof PDFArray) {
      encryptNestedStrings(obj, objKey, pdfDoc);
    }
  }

  const fileIdHex = PDFHexString.of(bytesToHex(fileId));
  pdfDoc.context.trailerInfo.Encrypt = encryptRef;
  pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([fileIdHex, fileIdHex]);

  return pdfDoc.save({ useObjectStreams: false });
}
