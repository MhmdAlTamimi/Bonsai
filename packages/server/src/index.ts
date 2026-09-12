import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
import { Settings } from './settings.js';
import { Connection } from './api/connectionGate.js';

const config = loadConfig();
const db = openDatabase(config.dataDir);
const store = new Store(db, config.reposRoot);
const bus = new EventBus();

const settings = new Settings(config);
const connection = new Connection(settings);

/**
 * D14e: agent invocation sits behind one interface.
 *
 * THE STAND-IN IS NOW OPT-IN, and only through an environment variable. It used
 * to be the automatic fallback whenever no credential was detected, which was
 * the right call while this was something to review and the wrong one the
 * moment it was something to use: a new user with a working subscription that
 * the old filesystem check could not see would get placeholder files and
 * reasonably conclude that is what Bonsai does. Silently doing something
 * different from what was asked is worse than refusing.
 *
 * Without BONSAI_FAKE_AGENT=1 there is exactly one runner, and the connection
 * gate stops runs before they start when it cannot reach Claude.
 */
const useStandIn = process.env['BONSAI_FAKE_AGENT'] === '1';
const jobs = new RunJobs(
  store,
  bus,
  useStandIn ? new FakeRunner() : new ClaudeSdkRunner(),
  settings,
);
if (useStandIn) {
  process.stdout.write('[bonsai] agent: STAND-IN (BONSAI_FAKE_AGENT=1) — output is fake\n');
}

// Check on startup so the UI knows immediately, without blocking the listen.
void connection.check().then((status) => {
  process.stdout.write(
    status.state === 'connected'
      ? `[bonsai] connected to Claude (${status.model}, credential: ${status.apiKeySource})\n`
      : `[bonsai] not connected: ${status.state}${status.message === null ? '' : ` — ${status.message}`}\n`,
  );
});

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
    if (await handleApi(req, res, { store, bus, jobs, settings, connection })) return;

    // Serve the built UI when it exists. In development the vite dev server
    // proxies /api here instead, so this path is unused.
    if (!existsSync(UI_DIST)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The interface is not built yet. Run `npm start`, which builds it.\n');
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

/**
 * Loopback only.
 *
 * This API creates git repositories, runs an agent with file-editing
 * permission, and has no authentication of any kind — it assumes the only
 * caller is the person sitting at the machine. Binding every interface put
 * that on the local network: on a cafe or office wifi, anyone could drive it.
 * D13 says local, and this is what local has to mean.
 */
server.listen(config.port, '127.0.0.1', () => {
  const url = `http://localhost:${config.port}`;
  process.stdout.write(`[bonsai] ${url}  (data: ${config.dataDir})\n`);
  if (process.argv.includes('--open')) openInBrowser(url);
});

/** `npm start` should end with Bonsai on screen, not with a URL to copy. */
function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], {
      shell: process.platform === 'win32',
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // A headless machine has no browser to open; the URL above is enough.
  }
}

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
