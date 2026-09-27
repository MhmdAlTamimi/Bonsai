import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The UI never talks to git, the filesystem or the agent. It talks here.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React, the other libraries and the app in chunks of their own. In
        // one bundle the three (about 200 kB each) passed Vite's 500 kB
        // warning together, although none comes near it alone. Split, the
        // warning stays meaningful: it fires again only if one part grows.
        //
        // By path, not the object form: React is CommonJS, and with it the
        // object form produced an empty React chunk. Either separator, for
        // Windows.
        manualChunks(id) {
          if (!/[\\/]node_modules[\\/]/.test(id)) return undefined;
          return /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)
            ? 'react'
            : 'vendor';
        },
      },
    },
  },
});
