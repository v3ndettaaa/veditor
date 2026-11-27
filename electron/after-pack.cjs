'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Generates a minimal POSIX launcher wrapper for Linux Electron builds.
 * Injects native Wayland Ozone and pinch/smooth-scroll flags BEFORE Electron's
 * C++ PreEarlyInitialization / Zygote startup so Hyprland/Wayland pinch gestures
 * (`zwp_pointer_gestures_v1`) work out of the box in both AppImage and .deb builds.
 */
function buildWaylandWrapperScript(binaryName) {
  return [
    '#!/bin/sh',
    '',
    'SELF="$0"',
    'if command -v readlink >/dev/null 2>&1; then',
    '  RESOLVED="$(readlink -f "$SELF" 2>/dev/null || true)"',
    '  if [ -n "$RESOLVED" ]; then',
    '    SELF="$RESOLVED"',
    '  fi',
    'fi',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"',
    `BIN="$DIR/${binaryName}"`,
    '',
    'has_explicit_ozone=0',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --ozone-platform|--ozone-platform=*)',
    '      has_explicit_ozone=1',
    '      break',
    '      ;;',
    '  esac',
    'done',
    '',
    'if [ "$has_explicit_ozone" -eq 0 ] && { [ -n "$WAYLAND_DISPLAY" ] || [ "$XDG_SESSION_TYPE" = "wayland" ]; }; then',
    '  export ELECTRON_OZONE_PLATFORM_HINT=wayland',
    '  exec "$BIN" \\',
    '    --ozone-platform=wayland \\',
    '    --enable-features=UseOzonePlatform,WaylandWindowDecorations \\',
    '    --enable-pinch \\',
    '    --enable-smooth-scrolling \\',
    '    "$@"',
    'fi',
    '',
    'export ELECTRON_OZONE_PLATFORM_HINT=auto',
    'exec "$BIN" \\',
    '  --ozone-platform-hint=auto \\',
    '  --enable-pinch \\',
    '  --enable-smooth-scrolling \\',
    '  "$@"',
    ''
  ].join('\n');
}

async function afterPack(context) {
  if (!context || context.electronPlatformName !== 'linux') {
    return;
  }

  const appOutDir = context.appOutDir;
  const executableName =
    context.packager?.executableName ||
    context.packager?.appInfo?.executableName ||
    'veditor-electron';

  const originalPath = path.join(appOutDir, executableName);
  const binaryName = `${executableName}.bin`;
  const renamedPath = path.join(appOutDir, binaryName);

  if (!fs.existsSync(originalPath)) {
    throw new Error(`afterPack: expected Linux executable at ${originalPath}`);
  }

  if (!fs.existsSync(renamedPath)) {
    fs.renameSync(originalPath, renamedPath);
  }

  const wrapper = buildWaylandWrapperScript(binaryName);
  fs.writeFileSync(originalPath, wrapper, { mode: 0o755 });
  fs.chmodSync(originalPath, 0o755);
}

afterPack.default = afterPack;
afterPack.buildWaylandWrapperScript = buildWaylandWrapperScript;
module.exports = afterPack;
