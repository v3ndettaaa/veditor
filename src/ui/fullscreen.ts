/**
 * Fullscreen helpers shared by the header and command palette.
 * Browser and Tauri webviews expose the standard Fullscreen API.
 */

export function isFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}

export async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}
