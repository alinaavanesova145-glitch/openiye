/// <reference types="vitest/config" />
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ESM has no __dirname — package.json declares "type": "module".
const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // vite-tsconfig-paths dropped 2026-08-26 — vite 8 resolves tsconfig
  // `paths` natively via this option, no plugin needed.
  resolve: { tsconfigPaths: true },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
  build: {
    // vendor-3d (three.js + @react-three/*) is deliberately large and
    // deliberately isolated — it's lazy-loaded behind VectorViewport's
    // Suspense boundary, never part of the initial bundle. The default
    // 500kB warning exists to catch accidental initial-bundle bloat, which
    // this isn't; raised so the build stays warning-free for a chunk we
    // already chose to split out rather than shrink further.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      // Multi-page entry, restructured 2026-08-27 — index.html is now the
      // marketing landing page (source: src/landing/main.tsx) and app.html
      // is the operational 3D canvas app (source: src/main.tsx). Previously
      // the app was index.html and the landing page was a second entry
      // (landing.html); that made Cloudflare Pages' built-in HTML
      // canonicalization redirect the public root away from the landing
      // page (see docs/idealization_report.md, 2026-08-26 sprint) — since
      // the literal filename at the build root now matches what the root
      // URL is supposed to serve, there's nothing left for Cloudflare to
      // canonicalize away from.
      input: {
        landing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
      output: {
        // three/@react-three/* are the vast majority of the bundle and are
        // only reachable from the lazy-loaded VectorViewport — naming this
        // chunk explicitly (rather than relying on the default dynamic-import
        // boundary) keeps it independently cacheable if VectorViewport's own
        // code changes without a three.js version bump.
        manualChunks(id) {
          if (
            id.includes('node_modules/three') ||
            id.includes('node_modules/@react-three')
          ) {
            return 'vendor-3d'
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      // Proxy WebSocket /stream → FastAPI on port 8050
      '/stream': {
        target: 'ws://127.0.0.1:8050',
        ws: true,
        changeOrigin: true,
      },
      // Proxy WebSocket /ws/vectors → FastAPI on port 8050
      '/ws': {
        target: 'ws://127.0.0.1:8050',
        ws: true,
        changeOrigin: true,
      },
      // Proxy REST /api/* → FastAPI on port 8050
      '/api': {
        target: 'http://127.0.0.1:8050',
        changeOrigin: true,
      },
    },
  },
})
