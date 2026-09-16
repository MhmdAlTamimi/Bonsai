/**
 * What one experiment actually costs the local server, in requests.
 *
 * Run `npm run build` first. Starts Bonsai on a temporary data directory with
 * the stand-in agent, creates a project, runs it once, and reports every fetch
 * the interface made, grouped by endpoint -- plus the server-sent events that
 * arrived, since the old refetch rule was "two requests per event".
 *
 *   node scripts/measure-requests.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from './browser-check.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

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

const dataDir = await mkdtemp(join(tmpdir(), 'bonsai-measure-'));
const server = spawn(
  process.execPath,
  ['--no-warnings', join(repoRoot, 'packages/server/dist/index.js')],
  {
    env: {
      ...process.env,
      BONSAI_DATA_DIR: dataDir,
      BONSAI_PORT: String(PORT),
      BONSAI_FAKE_AGENT: '1',
      BONSAI_FAKE_DELAY_MS: '400',
    },
    stdio: 'ignore',
  },
);

const until = async (check, label, ms = 30000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

let session;
try {
  await until(async () => (await fetch(`${BASE}/api/settings`)).ok, 'the server');
  session = await launch({ url: 'about:blank' });
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTERS });
  await session.goto(BASE);

  await session.waitFor("!!document.querySelector('.new-project')");
  await session.type('.new-project input[aria-label="project name"]', 'measure');
  await session.type('.new-project textarea', 'measure the request cost of one run');
  await session.eval(
    "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Change folder…').click()",
  );
  await session.waitFor("!!document.querySelector('.picker-list button')");
  await session.type('.picker input', dataDir);
  await session.click('.picker-bar button:nth-of-type(2)');
  await session.waitFor(
    `document.querySelector('.picker input').value === ${JSON.stringify(dataDir)} && !document.querySelector('.picker > button').disabled`,
  );
  await session.click('.picker > button');
  await session.waitFor("!document.querySelector('.new-project .row button').disabled");
  await session.click('.new-project .row button');
  await session.waitFor("document.querySelector('.panel h2')?.textContent === 'master'");

  // Everything above is setup. Measure one run, from here.
  await session.eval('window.__calls = {}; window.__events = {};');
  await session.click('.composer-row button');
  await session.waitFor(
    "!document.querySelector('.panel button.stop') && document.querySelector('.composer-row button')?.textContent === 'Send'",
  );
  // Let anything the finish triggers settle before reading the counters.
  await new Promise((r) => setTimeout(r, 1500));

  const calls = await session.eval('JSON.stringify(window.__calls)');
  const events = await session.eval('JSON.stringify(window.__events)');
  const parsedCalls = JSON.parse(calls);
  const parsedEvents = JSON.parse(events);
  const total = Object.values(parsedCalls).reduce((a, b) => a + b, 0);
  const refetching = ['tree.updated', 'node.status', 'run.question', 'run.finished', 'run.error']
    .map((t) => parsedEvents[t] ?? 0)
    .reduce((a, b) => a + b, 0);

  console.log(
    JSON.stringify(
      {
        oneRun: { requests: total, byEndpoint: parsedCalls },
        events: parsedEvents,
        refetchTriggeringEvents: refetching,
        requestsAvoidedByNotRecheckingTheCredential: refetching * 2,
      },
      null,
      2,
    ),
  );
} finally {
  session?.close();
  server.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
}
