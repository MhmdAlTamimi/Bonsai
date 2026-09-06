import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI never talks to git, the filesystem or the agent. It talks here.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
