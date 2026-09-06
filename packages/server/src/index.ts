import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { seedDemoProject } from './db/seed.js';
import { Store } from './db/store.js';
import { EventBus } from './api/events.js';
import { handleApi } from './api/router.js';

const config = loadConfig();
const db = openDatabase(config.dataDir);
const store = new Store(db, config.reposRoot);
const bus = new EventBus();

// M1 has no project-creation flow (that is the git layer), so the canvas needs
// something to render. Seeded once; delete the db file to reset.
if (store.listProjects().length === 0) {
  const id = seedDemoProject(db, config.reposRoot);
  process.stdout.write(`[bonsai] seeded demo project ${id}\n`);
}

const UI_DIST = resolve(fileURLToPath(new URL('../../ui/dist', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  void (async () => {
    if (await handleApi(req, res, { store, bus })) return;

    // Serve the built UI when it exists. In development the vite dev server
    // proxies /api here instead, so this path is unused.
    if (!existsSync(UI_DIST)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('UI is not built. Run `npm run dev:ui` for the dev server.\n');
      return;
    }
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    const candidate = join(UI_DIST, normalize(urlPath));
    const file =
      candidate.startsWith(UI_DIST) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(UI_DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })();
});

server.listen(config.port, () => {
  process.stdout.write(`[bonsai] http://localhost:${config.port}  (data: ${config.dataDir})\n`);
});

const shutdown = (): void => {
  bus.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
