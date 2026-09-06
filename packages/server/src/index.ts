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
import { RunJobs } from './jobs/runNode.js';
import { FakeRunner } from './agent/FakeRunner.js';
import { ClaudeSdkRunner } from './agent/ClaudeSdkRunner.js';
import { hasAgentCredentials } from './agent/credentials.js';

const config = loadConfig();
const db = openDatabase(config.dataDir);
const store = new Store(db, config.reposRoot);
const bus = new EventBus();

/**
 * D14e: agent invocation sits behind one interface, so this is the whole of the
 * M2 -> M3 swap.
 *
 * Falling back to the stand-in when there are no credentials is deliberate: it
 * keeps the app reviewable, and the whole git layer testable, without an API
 * key or a cent of spend. BONSAI_FAKE_AGENT=1 forces it even when a key exists.
 */
const useRealAgent = process.env['BONSAI_FAKE_AGENT'] !== '1' && hasAgentCredentials();
const jobs = new RunJobs(store, bus, useRealAgent ? new ClaudeSdkRunner() : new FakeRunner());
process.stdout.write(
  useRealAgent
    ? '[bonsai] agent: Claude Agent SDK\n'
    : '[bonsai] agent: stand-in (no credentials found; runs cost nothing and call nothing)\n',
);

// D31: any run still marked `running` in the database died with the process,
// because nothing survives the exit. Recovery itself lands in M4; noticing is
// cheap and belongs here from the start.
const orphaned = store.markOrphanedRunsInterrupted();
if (orphaned > 0) {
  process.stdout.write(`[bonsai] marked ${orphaned} interrupted run(s) from a previous session\n`);
}

// Projects can be created for real now, so the seed is opt-in rather than
// automatic -- a seeded tree has fake commit shas and no worktrees behind it.
if (process.env['BONSAI_SEED'] === '1' && store.listProjects().length === 0) {
  const id = seedDemoProject(db, config.reposRoot);
  process.stdout.write(`[bonsai] seeded fake demo project ${id} (no git behind it)\n`);
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
    if (await handleApi(req, res, { store, bus, jobs })) return;

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
    // Let cancelled runs unwind before the database goes away, or their final
    // writes throw into a promise nobody is awaiting. D31 then picks up
    // anything still marked `running` on the next start.
    void jobs.drain(3000).finally(() => {
      db.close();
      process.exit(0);
    });
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
