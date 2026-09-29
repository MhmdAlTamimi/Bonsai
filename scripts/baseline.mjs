/**
 * The numbers later changes are measured against.
 *
 * Re-run it after a batch of fixes and compare the two files: it measures the
 * same things the same way every time, on the machine it runs on. Timings are
 * only comparable on one machine; counts and sizes are comparable anywhere.
 *
 *   npm run build
 *   node scripts/baseline.mjs                  # everything, about five minutes
 *   node scripts/baseline.mjs --skip-tests     # runtime numbers only
 *
 * Writes test-results/baseline.json and prints a summary. Every server it
 * starts uses a temporary data folder and the stand-in agent: nothing touches
 * your own projects, and no credentials or network are used.
 *
 * Replaces measure-requests.mjs, which drove the start page by its old
 * selectors and broke when the page was redesigned. This creates projects
 * through the API, so the page can change without breaking the measurement.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { launch } from './browser-check.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(repoRoot, 'packages/server/dist/index.js');
const args = new Set(process.argv.slice(2));
const out = { machine: machine(), measuredAt: new Date().toISOString() };

// -- helpers -------------------------------------------------------------------

function machine() {
  const cpus = (() => {
    try {
      return readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm)?.length ?? null;
    } catch {
      return null;
    }
  })();
  return { platform: process.platform, node: process.version, cpus };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Resident memory of a process, in MB. Null where `ps` is not available (Windows). */
function rssMb(pid) {
  if (process.platform === 'win32') return null;
  try {
    const kb = Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
        .toString()
        .trim(),
    );
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: round(at(0.5)), p95: round(at(0.95)), n: sorted.length };
}

const round = (n) => Math.round(n * 10) / 10;

function dbSizeKb(dataDir) {
  let bytes = 0;
  for (const name of ['bonsai.db', 'bonsai.db-wal', 'bonsai.db-shm']) {
    const path = join(dataDir, name);
    if (existsSync(path)) bytes += statSync(path).size;
  }
  return Math.round(bytes / 1024);
}

async function startServer(dataDir) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const started = performance.now();
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...process.env,
      BONSAI_DATA_DIR: dataDir,
      BONSAI_PORT: String(port),
      BONSAI_FAKE_AGENT: '1',
      BONSAI_FAKE_DELAY_MS: '30',
      BONSAI_FAKE_BACKGROUND_MS: '1000',
    },
    stdio: 'ignore',
  });
  await until(async () => (await fetch(`${base}/api/settings`)).ok, 'the server');
  const readyMs = round(performance.now() - started);
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text === '' ? null : JSON.parse(text);
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  };
  return { base, child, readyMs, api, stop };
}

async function waitReady(api, nodeId) {
  await until(
    async () => (await api('GET', `/api/nodes/${nodeId}`)).node.status === 'ready',
    `run on ${nodeId}`,
  );
}

async function timeRequests(api, path, count) {
  for (let i = 0; i < 3; i++) await api('GET', path);
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const body = JSON.stringify(await api('GET', path));
    samples.push(performance.now() - start);
    bytes = body.length;
  }
  return { ...stats(samples), kb: Math.round(bytes / 1024) };
}

/** Counts every fetch and server-sent event the page handles. */
const COUNTERS = `
window.__calls = {};
window.__events = {};
const native = window.fetch;
window.fetch = (url, init) => {
  const path = String(url).split('?')[0].replace(/\\/[0-9a-f-]{36}/g, '/:id');
  const key = (init?.method ?? 'GET') + ' ' + path;
  window.__calls[key] = (window.__calls[key] ?? 0) + 1;
  return native(url, init);
};
const NativeSource = window.EventSource;
window.EventSource = class extends NativeSource {
  addEventListener(type, handler, options) {
    super.addEventListener(type, (event) => {
      window.__events[type] = (window.__events[type] ?? 0) + 1;
      handler(event);
    }, options);
  }
};
`;

async function heap(session) {
  await session.send('HeapProfiler.collectGarbage');
  const { result } = await session.send('Performance.getMetrics');
  const metric = (name) => result.metrics.find((m) => m.name === name)?.value ?? null;
  return {
    jsHeapMb: round((metric('JSHeapUsedSize') ?? 0) / 1024 / 1024),
    domNodes: metric('Nodes'),
    listeners: metric('JSEventListeners'),
  };
}

/** Selects a card the way a keyboard user does, without reloading the page. */
async function select(session, nodeId, name) {
  await session.eval(`(() => {
    const el = document.querySelector('.react-flow__node[data-id="${nodeId}"]');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  })()`);
  await session.waitFor(
    `document.querySelector('.panel h2')?.textContent === ${JSON.stringify(name)}`,
  );
}

// -- 1. tests and coverage -----------------------------------------------------

function runTests(label, command) {
  const started = performance.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const number = (name) => Number(text.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1] ?? NaN);
  const all = text.match(/^# all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m);
  const files = [...text.matchAll(/^#\s*([\w.-]+\.tsx?)\s*\|/gm)].length;
  return {
    label,
    tests: number('tests'),
    passed: number('pass'),
    failed: number('fail'),
    seconds: round((performance.now() - started) / 1000),
    coverage: all
      ? { lines: Number(all[1]), branches: Number(all[2]), functions: Number(all[3]) }
      : null,
    filesMeasured: files,
  };
}

if (!args.has('--skip-tests')) {
  const exclude = [
    '--test-coverage-exclude=**/*.test.*',
    '--test-coverage-exclude=**/e2e.spec.*',
    '--test-coverage-exclude=**/node_modules/**',
    '--test-coverage-exclude=packages/server/dist/testing/**',
  ];
  out.tests = [
    runTests('server', [
      process.execPath,
      '--enable-source-maps',
      '--test',
      '--experimental-test-coverage',
      ...exclude,
      'packages/server/dist/**/*.test.js',
    ]),
    runTests('interface and shared', [
      process.execPath,
      '--experimental-strip-types',
      '--no-warnings',
      '--test',
      '--experimental-test-coverage',
      ...exclude,
      'packages/ui/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
    ]),
  ];
  const e2e = runTests('browser', [process.execPath, '--test', 'packages/server/dist/e2e.spec.js']);
  delete e2e.coverage;
  delete e2e.filesMeasured;
  out.tests.push(e2e);
}

// -- 2. what the browser downloads --------------------------------------------

{
  const assets = join(repoRoot, 'packages/ui/dist/assets');
  const files = readdirSync(assets).map((name) => {
    const body = readFileSync(join(assets, name));
    return {
      name,
      kb: round(body.length / 1024),
      gzipKb: round(gzipSync(body, { level: 9 }).length / 1024),
    };
  });
  const total = (ext, key) =>
    round(files.filter((f) => f.name.endsWith(ext)).reduce((n, f) => n + f[key], 0));
  out.bundle = {
    files,
    js: { kb: total('.js', 'kb'), gzipKb: total('.js', 'gzipKb') },
    css: { kb: total('.css', 'kb'), gzipKb: total('.css', 'gzipKb') },
  };
}

// -- 3. startup, and a tree as it grows ----------------------------------------

{
  const dataDir = await mkdtemp(join(tmpdir(), 'bonsai-baseline-scale-'));
  let server = await startServer(dataDir);
  try {
    out.startup = { emptyDataFolderMs: server.readyMs, idleRssMb: rssMb(server.child.pid) };
    const project = await server.api('POST', '/api/projects', { name: 'scale', description: '' });
    const ids = [project.masterNodeId];
    out.scale = [];
    for (const target of [10, 100, 500]) {
      const creations = [];
      while (ids.length < target) {
        // A bushy tree, three children per experiment, the way people branch.
        const parentId = ids[Math.floor((ids.length - 1) / 3)];
        const start = performance.now();
        const made = await server.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId,
          displayName: `Experiment ${ids.length}`,
          description: '',
        });
        creations.push(performance.now() - start);
        ids.push(made.node.id);
      }
      out.scale.push({
        experiments: target,
        createExperimentMs: creations.length > 0 ? stats(creations) : null,
        treeRequest: await timeRequests(server.api, `/api/projects/${project.projectId}/tree`, 20),
        databaseKb: dbSizeKb(dataDir),
        serverRssMb: rssMb(server.child.pid),
      });
    }

    // The map with every card on it: how long until all 500 are drawn.
    const session = await launch({ url: 'about:blank' });
    try {
      await session.send('Performance.enable');
      const start = performance.now();
      await session.goto(`${server.base}/?project=${project.projectId}`);
      await session.waitFor(
        `document.querySelectorAll('.react-flow__node').length === ${ids.length} && !!document.querySelector('.panel h2')`,
        { timeoutMs: 60_000 },
      );
      out.mapWith500 = { firstDrawMs: round(performance.now() - start), ...(await heap(session)) };
    } finally {
      session.close();
    }

    // A restart with that tree on disk: startup recovery and ref checks run
    // over every experiment.
    await server.stop();
    server = await startServer(dataDir);
    out.startup.with500ExperimentsMs = server.readyMs;
    const firstTree = performance.now();
    await server.api('GET', `/api/projects/${project.projectId}/tree`);
    out.startup.firstTreeAfterRestartMs = round(performance.now() - firstTree);
  } finally {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// -- 4. a long session ---------------------------------------------------------

{
  const dataDir = await mkdtemp(join(tmpdir(), 'bonsai-baseline-session-'));
  const server = await startServer(dataDir);
  let session;
  try {
    const project = await server.api('POST', '/api/projects', { name: 'session', description: '' });
    const children = [];
    for (let i = 0; i < 20; i++) {
      const made = await server.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: `Session ${i + 1}`,
        description: '',
      });
      children.push({ id: made.node.id, name: `Session ${i + 1}` });
    }

    session = await launch({ url: 'about:blank' });
    await session.send('Performance.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTERS });
    await session.goto(`${server.base}/?project=${project.projectId}&node=${project.masterNodeId}`);
    await session.waitFor(
      `document.querySelectorAll('.react-flow__node').length === ${children.length + 1}`,
    );
    await delay(1000);
    const before = { serverRssMb: rssMb(server.child.pid), page: await heap(session) };

    // One run, watched from the page: what it costs the local server.
    await session.eval('window.__calls = {}; window.__events = {};');
    await server.api('POST', `/api/nodes/${project.masterNodeId}/runs`, { prompt: 'first' });
    await waitReady(server.api, project.masterNodeId);
    await delay(1500);
    const calls = JSON.parse(await session.eval('JSON.stringify(window.__calls)'));
    const events = JSON.parse(await session.eval('JSON.stringify(window.__events)'));
    out.oneRunWatched = {
      requests: Object.values(calls).reduce((a, b) => a + b, 0),
      events: Object.values(events).reduce((a, b) => a + b, 0),
      byEndpoint: calls,
      byEvent: events,
    };

    // Sixty runs, three per experiment, with the page open throughout.
    const runMs = [];
    for (let round_ = 0; round_ < 3; round_++) {
      for (const child of children) {
        const start = performance.now();
        await server.api('POST', `/api/nodes/${child.id}/runs`, { prompt: `step ${round_ + 1}` });
        await waitReady(server.api, child.id);
        runMs.push(performance.now() - start);
      }
    }

    // Moving between experiments, as you do all day.
    await session.eval('window.__calls = {};');
    const switchMs = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const child of children) {
        const start = performance.now();
        await select(session, child.id, child.name);
        switchMs.push(performance.now() - start);
      }
    }
    const switchCalls = JSON.parse(await session.eval('JSON.stringify(window.__calls)'));
    await delay(1000);
    out.longSession = {
      runs: runMs.length + 1,
      runMs: stats(runMs),
      selections: switchMs.length,
      selectMs: stats(switchMs),
      requestsPerSelection: round(
        Object.values(switchCalls).reduce((a, b) => a + b, 0) / switchMs.length,
      ),
      before,
      after: { serverRssMb: rssMb(server.child.pid), page: await heap(session) },
      databaseKb: dbSizeKb(dataDir),
    };
  } finally {
    session?.close();
    await server.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// -- report ----------------------------------------------------------------------

mkdirSync(join(repoRoot, 'test-results'), { recursive: true });
const file = join(repoRoot, 'test-results', 'baseline.json');
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.error(`\nWritten to ${file}`);
