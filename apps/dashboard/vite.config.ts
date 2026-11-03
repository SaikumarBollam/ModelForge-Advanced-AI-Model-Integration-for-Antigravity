import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard is served by the gateway at /ui/ in production and proxies
// API calls to the gateway during development.
export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
    },
  },
});
