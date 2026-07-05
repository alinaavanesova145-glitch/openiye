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
