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
  /** TEMPORARY Day-3 probe segments (ms): IPC round-trip vs PNG decode. */
  ipcMs: number;
  decodeMs: number;
}

async function invokeEngine<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Bump the server navigation generation (invalidates older queued work).
 * Call on page jumps / zoom / rotation commits BEFORE requesting the new
 * generation's tiles. */
export async function beginEngineNavigation(docId: string): Promise<number> {
  return invokeEngine<number>('engine_begin_navigation', { docId });
}

/** True for server stale-generation rejections (quiet abort, no fallback). */
export function isEngineStaleError(e: unknown): boolean {
  return /stale/i.test(e instanceof Error ? e.message : String(e));
}

export interface EngineMetricsSnapshot {
  queue_depth: number;
  queue_cancelled: number;
  cache: {
    hits: number;
    misses: number;
    evictions: number;
    used_bytes: number;
    budget_bytes: number;
    tile_count: number;
    hit_rate: number;
  };
  renders_total: number;
  last_tile_backend_ms: number;
  last_tile_render_ms: number;
  last_tile_encode_ms: number;
}

/** TEMPORARY Day-3 probe: server queue/cache/render counters (benchmarks). */
export async function fetchEngineMetrics(docId: string): Promise<EngineMetricsSnapshot | null> {
  try {
    return await invokeEngine<EngineMetricsSnapshot | null>('engine_metrics', { docId });
  } catch {
    return null;
  }
}

function toImageBytes(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (raw instanceof Uint8Array) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  // Fallback for JSON-shaped payloads (should not happen for Raw bodies).
  return new Uint8Array(raw as number[]).buffer as ArrayBuffer;
}

/** Open a document in the engine. `path` is read in Rust (zero IPC bytes);
 * `bytes` travel as a RAW binary invoke payload (Uint8Array passed directly
 * + `x-doc-id` header) — never JSON number arrays, never base64. Returns the
 * engine page count. */
export async function openEngineDocument(
  docId: string,
  opts: { path?: string; bytes?: Uint8Array }
): Promise<number> {
  if (!isDesktop()) throw new Error('engine tiles require desktop (Tauri)');
  if (opts.path) {
    return invokeEngine<number>('engine_open_document', { docId, path: opts.path });
  }
  if (!opts.bytes) throw new Error('engine open needs path or bytes');
  const { invoke } = await import('@tauri-apps/api/core');
  // Two-step open: binary stash (fast transport) then parse (slow, threadpool).
  // Split timings isolate transfer cost from MuPDF parse cost.
  const t0 = performance.now();
  await invoke<void>('engine_open_bytes', opts.bytes, {
    headers: { 'x-doc-id': docId },
  });
  const transferMs = performance.now() - t0;
  const count = await invoke<number>('engine_open_finalize', { docId });
  console.info(
    `[mupdf] open doc=${docId} via=bytes(${opts.bytes.length}B) ` +
    `transfer=${transferMs.toFixed(0)}ms`
  );
  return count;
}

export async function closeEngineDocument(docId: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invokeEngine('engine_close_document', { docId });
  } catch (e) {
    console.warn('engine close failed:', e);
  }
}

function tileKey(spec: EngineTileSpec): string {
  const t = spec.tile;
  return `${t.doc}|${t.page}|${t.zoom_milli}|${t.dpr_milli}|${t.rotation_deg}|${t.tx}|${t.ty}`;
}

// In-flight byte requests, shared across concurrent render passes so the same
// tile is never requested twice at once. Shares PNG BYTES (not bitmaps):
// each waiter decodes its own ImageBitmap because drawing uses a bitmap after
// another waiter may have closed a shared one (neutered bitmaps draw blank).
const inflightBytes = new Map<string, Promise<ArrayBuffer>>();

async function fetchTileBytes(
  spec: EngineTileSpec,
  priority: number,
  generation: number
): Promise<ArrayBuffer> {
  // Keyed by tile+generation (NOT priority): concurrent passes with different
  // priorities share one invoke; the server queue resolves the priority and
  // dedups the render. Generation partitions stale from current bytes.
  const key = `${tileKey(spec)}|g${generation}`;
  let pending = inflightBytes.get(key);
  if (!pending) {
    pending = (async () => {
      const raw = await invokeEngine<unknown>('engine_render_tile', {
        spec: { tile: spec.tile, tile_px: spec.tile_px },
        priority,
        generation,
      });
      return toImageBytes(raw);
    })();
    inflightBytes.set(key, pending);
    try {
      await pending;
    } finally {
      if (inflightBytes.get(key) === pending) inflightBytes.delete(key);
    }
  }
  return pending;
}

/** Render one tile: small-JSON request out, PNG bytes back, decoded bitmap.
 * `ipcMs` covers request → bytes arrival for THIS waiter (includes dedup
 * sharing and server queue wait, not just transport) — the honest number. */
export async function renderEngineTile(
  spec: EngineTileSpec,
  priority = 1,
  generation = 0
): Promise<EngineTile> {
  const t0 = performance.now();
  const buf = await fetchTileBytes(spec, priority, generation);
  const ipcMs = performance.now() - t0;
  const blob = new Blob([buf], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const decodeMs = performance.now() - t0 - ipcMs;
  return { width: bitmap.width, height: bitmap.height, bitmap, ipcMs, decodeMs };
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
