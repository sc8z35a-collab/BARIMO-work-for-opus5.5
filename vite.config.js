import { defineConfig } from 'vite';
// BASE: '/' locally; set BARIMO_BASE=/<repo>/ for GitHub Pages builds
export default defineConfig({
  base: process.env.BARIMO_BASE || '/',
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
});
