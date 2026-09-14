import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig(({ mode }) => {
  const isDesktop = mode === 'desktop';
  const isFirefox = mode === 'firefox';
  const outDir = isDesktop ? 'dist/desktop' : (isFirefox ? 'dist/firefox' : 'dist/chrome');

  const input = isDesktop
    ? { main: resolve(import.meta.dirname, 'index.html') }
    : {
        main: resolve(import.meta.dirname, 'index.html'),
        popup: resolve(import.meta.dirname, 'popup.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts')
      };

  return {
    base: './',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input,
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
        '@': resolve(import.meta.dirname, 'src')
      }
    },
    plugins: [
      {
        name: 'copy-extension-manifest-and-assets',
        closeBundle() {
          // Copy appropriate manifest if building an extension
          if (!isDesktop) {
            const manifestSource = isFirefox ? 'manifest.firefox.json' : 'manifest.chrome.json';
            if (fs.existsSync(manifestSource)) {
              fs.copyFileSync(manifestSource, `${outDir}/manifest.json`);
              console.log(`Copied ${manifestSource} -> ${outDir}/manifest.json`);
            }
          }

          // Ensure icons directory is copied
          const iconsSrc = resolve(import.meta.dirname, 'public/icons');
          const iconsDest = resolve(import.meta.dirname, `${outDir}/icons`);
          if (fs.existsSync(iconsSrc)) {
            fs.mkdirSync(iconsDest, { recursive: true });
            fs.readdirSync(iconsSrc).forEach(file => {
              fs.copyFileSync(resolve(iconsSrc, file), resolve(iconsDest, file));
            });
            console.log(`Copied icons to ${iconsDest}`);
          }

          // Copy PDF.js worker
          const workerSrc = resolve(import.meta.dirname, 'public/pdf.worker.min.mjs');
          if (fs.existsSync(workerSrc)) {
            fs.copyFileSync(workerSrc, `${outDir}/pdf.worker.min.mjs`);
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
            resolve(import.meta.dirname, 'node_modules/pdfjs-dist/cmaps'),
            resolve(import.meta.dirname, `${outDir}/cmaps`)
          );
          copyDirRecursive(
            resolve(import.meta.dirname, 'node_modules/pdfjs-dist/standard_fonts'),
            resolve(import.meta.dirname, `${outDir}/standard_fonts`)
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
