import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Use 127.0.0.1 explicitly: server binds to IPv4 localhost (see packages/server/src/index.ts).
// `localhost` may resolve to ::1 first and fail to connect.
const SERVER_TARGET = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: SERVER_TARGET, changeOrigin: true },
      '/orchestrators': { target: SERVER_TARGET, changeOrigin: true },
      '/sessions': { target: SERVER_TARGET, changeOrigin: true },
      '/health': { target: SERVER_TARGET, changeOrigin: true },
      // Plugin management REST + plugin-owned HTTP zones (feature B.3 iframes
      // load `/plugin-api/<name>/*` on the app origin, so the dev proxy must
      // forward them too).
      '/plugins': { target: SERVER_TARGET, changeOrigin: true },
      '/plugin-api': { target: SERVER_TARGET, changeOrigin: true },
      '/public': { target: SERVER_TARGET, changeOrigin: true },
      // VS Code web: `/ide-info` (connection details) + `/ide` (the editor
      // itself, reverse-proxied by the server under that base path, incl. its
      // WebSocket). Both ride on the server's single port.
      '/ide-info': { target: SERVER_TARGET, changeOrigin: true },
      '/ide': { target: SERVER_TARGET, ws: true, changeOrigin: true },
      '/ws': { target: SERVER_TARGET, ws: true, changeOrigin: true },
    },
  },
});
