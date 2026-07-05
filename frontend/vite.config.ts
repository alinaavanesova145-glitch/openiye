/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
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
