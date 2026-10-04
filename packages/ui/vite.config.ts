import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = createHash('sha256');
function hashDirectory(folder: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) hashDirectory(path);
    else if (entry.isFile())
      hash.update(relative(root, path).replaceAll('\\', '/')).update(readFileSync(path));
  }
}
for (const name of ['shared', 'server', 'ui'])
  hashDirectory(resolve(root, 'packages', name, 'src'));
for (const name of ['package-lock.json', 'packages/ui/vite.config.ts'])
  hash.update(readFileSync(resolve(root, name)));
const buildId = hash.digest('hex').slice(0, 24);

export default defineConfig(({ command }) => ({
  define: { __BONSAI_BUILD_ID__: JSON.stringify(command === 'serve' ? 'development' : buildId) },
  plugins: [
    react(),
    {
      name: 'bonsai-build-identity',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build.json',
          source: JSON.stringify({ buildId }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
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
}));
