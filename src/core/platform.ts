/**
 * Runtime detection of the desktop (Tauri) shell vs. the browser extension.
 * The extension and desktop builds share one frontend bundle; this is the
 * single switch that lets code opt into native-only APIs (file system,
 * window events, native dialogs) without breaking the extension build.
 */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
