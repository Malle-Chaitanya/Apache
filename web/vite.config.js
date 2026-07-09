import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API calls to the Express backend on :4000.
// `npm run build` emits to ../public so `npm start` (Express) can serve it too.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: { outDir: '../public', emptyOutDir: true },
});
