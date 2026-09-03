import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig(({ mode }) => {
  const isFirefox = mode === 'firefox';
  const outDir = isFirefox ? 'dist/firefox' : 'dist/chrome';

  return {
    base: './',
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          popup: resolve(import.meta.dirname, 'popup.html'),
          'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts')
        },
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
          // Copy appropriate manifest
          const manifestSource = isFirefox ? 'manifest.firefox.json' : 'manifest.chrome.json';
          if (fs.existsSync(manifestSource)) {
            fs.copyFileSync(manifestSource, `${outDir}/manifest.json`);
            console.log(`Copied ${manifestSource} -> ${outDir}/manifest.json`);
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
        }
      }
    ],
    test: {
      globals: true,
      environment: 'node'
    }
  };
});
