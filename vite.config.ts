import { defineConfig } from 'vite';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const rootDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(resolve(rootDir, 'package.json'), 'utf-8'));

// Prevent Vite from exiting when spawned with closed stdin during container pre-warming
process.env.CI = 'true';

export default defineConfig(({ mode, command }) => {
  const isDesktop = mode === 'desktop';
  const isFirefox = mode === 'firefox';
  const outDir = isDesktop ? 'dist/desktop' : (isFirefox ? 'dist/firefox' : 'dist/chrome');

  const input: Record<string, string> = isDesktop
    ? { main: resolve(rootDir, 'index.html') }
    : {
        main: resolve(rootDir, 'index.html'),
        popup: resolve(rootDir, 'popup.html'),
        'service-worker': resolve(rootDir, 'src/background/service-worker.ts')
      };

  return {
    base: './',
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input,
        external: isDesktop ? [] : [/^@tauri-apps\/.*/],
        output: {
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'service-worker') {
              return 'service-worker.js';
            }
            return 'assets/[name]-[hash].js';
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]'
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(rootDir, 'src')
      }
    },
    plugins: [
      {
        name: 'copy-extension-manifest-and-assets',
        buildStart() {
          // Keep public/pdf.worker.min.mjs synchronized with installed pdfjs-dist version
          const distWorker = resolve(rootDir, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
          const publicWorker = resolve(rootDir, 'public/pdf.worker.min.mjs');
          if (fs.existsSync(distWorker)) {
            const needsCopy =
              !fs.existsSync(publicWorker) ||
              fs.statSync(distWorker).size !== fs.statSync(publicWorker).size;
            if (needsCopy) {
              fs.mkdirSync(dirname(publicWorker), { recursive: true });
              fs.copyFileSync(distWorker, publicWorker);
            }
          }
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0] || '';
            if (url.startsWith('/cmaps/') || url.startsWith('/standard_fonts/')) {
              const rel = url.slice(1);
              const filePath = resolve(rootDir, 'node_modules/pdfjs-dist', rel);
              if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                res.end(fs.readFileSync(filePath));
                return;
              }
            }
            next();
          });
        },
        closeBundle() {
          // Only copy extension build artifacts during actual production builds,
          // never during dev dependency pre-bundling or Vitest runs.
          if (command !== 'build' || process.env.VITEST) return;

          const outDirPath = resolve(rootDir, outDir);
          fs.mkdirSync(outDirPath, { recursive: true });

          // Copy appropriate manifest if building an extension
          if (!isDesktop) {
            const manifestSource = isFirefox ? 'manifest.firefox.json' : 'manifest.chrome.json';
            if (fs.existsSync(manifestSource)) {
              fs.copyFileSync(manifestSource, resolve(outDirPath, 'manifest.json'));
              console.log(`Copied ${manifestSource} -> ${outDir}/manifest.json`);
            }
          }

          // Ensure icons directory is copied
          const iconsSrc = resolve(rootDir, 'public/icons');
          const iconsDest = resolve(outDirPath, 'icons');
          if (fs.existsSync(iconsSrc)) {
            fs.mkdirSync(iconsDest, { recursive: true });
            fs.readdirSync(iconsSrc).forEach(file => {
              fs.copyFileSync(resolve(iconsSrc, file), resolve(iconsDest, file));
            });
            console.log(`Copied icons to ${iconsDest}`);
          }

          // Copy PDF.js worker
          const workerSrc = resolve(rootDir, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
          const fallbackWorkerSrc = resolve(rootDir, 'public/pdf.worker.min.mjs');
          const actualWorkerSrc = fs.existsSync(workerSrc) ? workerSrc : fallbackWorkerSrc;
          if (fs.existsSync(actualWorkerSrc)) {
            fs.copyFileSync(actualWorkerSrc, resolve(outDirPath, 'pdf.worker.min.mjs'));
            console.log(`Copied PDF.js worker to ${outDir}/pdf.worker.min.mjs`);
          }

          // Copy PDF.js cMaps + standard fonts for 100% offline rendering.
          // Without these, CJK / standard-font PDFs hit the network (or stall
          // under extension CSP) on the critical load path.
          const copyDirRecursive = (src: string, dest: string) => {
            if (!fs.existsSync(src)) return;
            fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
              const s = resolve(src, entry.name);
              const d = resolve(dest, entry.name);
              if (entry.isDirectory()) copyDirRecursive(s, d);
              else fs.copyFileSync(s, d);
            }
          };
          copyDirRecursive(
            resolve(rootDir, 'node_modules/pdfjs-dist/cmaps'),
            resolve(outDirPath, 'cmaps')
          );
          copyDirRecursive(
            resolve(rootDir, 'node_modules/pdfjs-dist/standard_fonts'),
            resolve(outDirPath, 'standard_fonts')
          );
        }
      }
    ],
    test: {
      globals: true,
      environment: 'node'
    }
  };
});
