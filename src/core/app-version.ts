/**
 * Resolves the running build's version at runtime instead of a string
 * hand-copied into the UI (which drifts the moment `package.json` bumps).
 * Desktop reads it from the Tauri app metadata (`tauri.conf.json`), the
 * extension reads it from its own installed manifest, and everything else
 * (dev server, tests) falls back to the build-time constant Vite injects
 * from `package.json`.
 */
import { isDesktop } from './platform';

declare const __APP_VERSION__: string;

function buildTimeFallback(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let cached: string | null = null;

export async function getAppVersion(): Promise<string> {
  if (cached) return cached;

  if (isDesktop()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      cached = await getVersion();
      return cached;
    } catch (e) {
      console.warn('Could not read desktop app version:', e);
    }
  }

  try {
    const api: any = (globalThis as any).chrome ?? (globalThis as any).browser;
    const manifestVersion = api?.runtime?.getManifest?.().version;
    if (manifestVersion) {
      cached = String(manifestVersion);
      return cached;
    }
  } catch (e) {
    // Not running as an extension; fall through.
  }

  cached = buildTimeFallback();
  return cached;
}
