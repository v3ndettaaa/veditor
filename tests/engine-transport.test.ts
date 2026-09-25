import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf-8');

/**
 * Regression guard for the Day-3 P0 transport fix: PDF bytes must NEVER
 * travel as JSON number arrays (12.8 MB once inflated to ~50 MB of JSON).
 * Allowed transports: filesystem path (Rust reads the file) and raw binary
 * invoke payloads (Uint8Array passed directly + headers). If this test fails,
 * someone reintroduced the slow path — fix the transport, not the test.
 */
describe('engine binary transport guard', () => {
  const client = read('src/io/engine-tiles.ts');
  const cmds = read('src-tauri/src/engine_cmds.rs');

  it('never converts PDF bytes with Array.from', () => {
    expect(client).not.toContain('Array.from(opts.bytes)');
    expect(client).not.toContain('Array.from(bytes)');
  });

  it('never base64-encodes PDF documents for transport', () => {
    // Match real encode/decode calls, not prose in comments.
    const banned = [/btoa\s*\(/, /atob\s*\(/, /toString\(\s*['"]base64['"]\s*\)/, /from\(\s*\w+\s*,\s*['"]base64['"]\s*\)/];
    for (const src of [client, cmds]) {
      for (const re of banned) {
        expect(src, `banned pattern ${re}`).not.toMatch(re);
      }
    }
  });

  it('Rust open commands take path or raw Request, never JSON byte arrays', () => {
    expect(cmds).not.toMatch(/bytes:\s*Option<Vec<u8>>/);
    expect(cmds).toContain('engine_open_bytes');
    expect(cmds).toContain('InvokeBody::Raw');
  });

  it('TS bytes open uses a raw binary invoke payload with headers', () => {
    expect(client).toContain('engine_open_bytes');
    expect(client).toContain('x-doc-id');
  });
});
