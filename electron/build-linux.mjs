import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPkgPath = path.resolve(__dirname, '..', 'package.json');
const electronPkgPath = path.resolve(__dirname, 'package.json');
const desktopDistDir = path.resolve(__dirname, '..', 'dist', 'desktop');

if (!fs.existsSync(path.join(desktopDistDir, 'index.html'))) {
  console.error('Missing dist/desktop/index.html. Run `npm run build:desktop` before packaging Electron.');
  process.exit(1);
}

const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8'));
const version = rootPkg.version;

// Keep electron/package.json version synchronized with root package.json so
// both runtime app.getVersion() and electron-builder artifact filenames match.
if (electronPkg.version !== version) {
  electronPkg.version = version;
  fs.writeFileSync(electronPkgPath, `${JSON.stringify(electronPkg, null, 2)}\n`, 'utf8');
}

const builderBin = path.resolve(
  __dirname,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);

execFileSync(
  builderBin,
  [
    '--linux',
    'AppImage',
    'deb',
    '--x64',
    '--config',
    'electron-builder.yml',
    `-c.extraMetadata.version=${version}`,
    '--publish',
    'never'
  ],
  {
    cwd: __dirname,
    stdio: 'inherit'
  }
);
