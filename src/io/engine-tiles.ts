/**
 * TEMPORARY migration client — delete after the MuPDF migration is complete.
 *
 * TypeScript client for the Rust tile API (`src-tauri/src/engine_cmds.rs`).
 * Desktop-only: every entry no-ops off-desktop so extension builds are
 * unaffected. Tile PNGs arrive as raw IPC bytes (`tauri::ipc::Response`),
 * never base64/JSON — see `docs/DAY2_MUPDF.md` for the copy table.
 */

import { isDesktop } from '../core/platform';

export const ENGINE_TILE_PX = 512;

export interface EngineTileSpec {
  tile: {
    doc: string;
    page: number;
    zoom_milli: number;
    dpr_milli: number;
    rotation_deg: number;
    tx: number;
    ty: number;
  };
  tile_px: number;
}

export interface EngineTile {
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

async function invokeEngine<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function toImageBytes(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  // Fallback for JSON-shaped payloads (should not happen for Raw bodies).
  return new Uint8Array(raw as number[]).buffer as ArrayBuffer;
}

/** Open a document in the engine. Prefers `path` (Rust reads the file, zero
 * IPC bytes) over `bytes`. Returns the engine page count. */
export async function openEngineDocument(
  docId: string,
  opts: { path?: string; bytes?: Uint8Array }
): Promise<number> {
  if (!isDesktop()) throw new Error('engine tiles require desktop (Tauri)');
  return invokeEngine<number>('engine_open_document', {
    docId,
    path: opts.path ?? null,
    bytes: opts.bytes ? Array.from(opts.bytes) : null,
  });
}

export async function closeEngineDocument(docId: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invokeEngine('engine_close_document', { docId });
  } catch (e) {
    console.warn('engine close failed:', e);
  }
}

/** Render one tile: small-JSON request out, PNG bytes back, decoded bitmap. */
export async function renderEngineTile(spec: EngineTileSpec): Promise<EngineTile> {
  const raw = await invokeEngine<unknown>('engine_render_tile', {
    spec: { tile: spec.tile, tile_px: spec.tile_px },
  });
  const buf = toImageBytes(raw);
  const blob = new Blob([buf], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  return { width: bitmap.width, height: bitmap.height, bitmap };
}

export function engineTileSpec(
  docId: string,
  page: number,
  zoom: number,
  dpr: number,
  rotation: number,
  tx: number,
  ty: number
): EngineTileSpec {
  return {
    tile: {
      doc: docId,
      page,
      zoom_milli: Math.round(zoom * 1000),
      dpr_milli: Math.round(dpr * 1000),
      rotation_deg: ((Math.round(rotation) % 360) + 360) % 360,
      tx,
      ty,
    },
    tile_px: ENGINE_TILE_PX,
  };
}
