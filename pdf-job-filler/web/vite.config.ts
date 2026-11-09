import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// pdf.js needs its font metrics / CMaps / wasm decoders as static files: copy them to public/pdfjs.
const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
for (const dir of ['standard_fonts', 'cmaps', 'wasm']) {
  const to = path.resolve(__dirname, 'public/pdfjs', dir);
  if (!fs.existsSync(to)) fs.cpSync(path.join(pdfjsDir, dir), to, { recursive: true });
}

// The shared extraction/fill logic lives in ../shared/src in this repo.
// In a Lovable project (single app, no monorepo) copy it to src/shared and it is picked up automatically.
const localShared = path.resolve(__dirname, 'src/shared');
const sharedDir = fs.existsSync(localShared) ? localShared : path.resolve(__dirname, '../shared/src');

export default defineConfig({
  server: { host: true, port: 8080, fs: { allow: [path.resolve(__dirname, '..')] } },
  preview: { host: true, port: 4173 },
  resolve: {
    alias: {
      '@shared': sharedDir,
      '@': path.resolve(__dirname, 'src'),
    },
    // ../shared imports pdf-lib: make sure it resolves to this app's copy
    dedupe: ['pdf-lib', '@pdf-lib/fontkit', 'pdfjs-dist'],
  },
  optimizeDeps: { include: ['pdf-lib', '@pdf-lib/fontkit'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PDF Job Filler',
        short_name: 'Job Filler',
        description: 'Fill PDF forms from a source PDF with a saved template.',
        theme_color: '#1e3a5f',
        background_color: '#f4f6f9',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,woff2}', 'pdfjs/standard_fonts/*'],
        runtimeCaching: [
          {
            urlPattern: /\/pdfjs\/(cmaps|wasm)\//,
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-assets', expiration: { maxEntries: 300 } },
          },
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
});
