/**
 * Audit S1: two copies of Bonsai on one data folder.
 *
 *   npm run build:server && node scripts/audit/two-instances.mjs
 *
 * Starts copy A with a long stand-in run, then B on the same folder and port
 * (what `npm start` twice does), then C on the same folder and another port,
 * and prints what each did to A's run. Uses a temporary data folder.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '../../packages/server/dist/index.js');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = await mkdtemp(join(tmpdir(), 'bonsai-two-'));

function start(port) {
  const output = [];
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...process.env,
      BONSAI_DATA_DIR: dataDir,
      BONSAI_PORT: String(port),
      BONSAI_FAKE_AGENT: '1',
      BONSAI_FAKE_DELAY_MS: '12000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  return { child, output };
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ready(base) {
  for (;;) {
    try {
      if ((await fetch(`${base}/api/settings`)).ok) return;
    } catch {
      // Not up yet.
    }
    await delay(50);
  }
}

function recorded(nodeId) {
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const node = db.prepare('SELECT status FROM node WHERE id = ?').get(nodeId).status;
  const runs = db
    .prepare(
      'SELECT status, end_reason AS reason, error FROM run WHERE node_id = ? ORDER BY started_at',
    )
    .all(nodeId);
  db.close();
  return { node, runs };
}

const P = 8950 + Math.floor(Math.random() * 20);
const Q = P + 30;
const baseA = `http://127.0.0.1:${P}`;
const A = start(P);
const others = [];
try {
  await ready(baseA);
  const project = (await api(baseA, 'POST', '/api/projects', { name: 'two', description: '' }))
    .body;
  const nodeId = project.masterNodeId;
  await api(baseA, 'POST', `/api/nodes/${nodeId}/runs`, { prompt: 'a long run' });
  await delay(1500);
  console.log('1. A is running:', JSON.stringify(recorded(nodeId)));

  const B = start(P);
  others.push(B);
  await delay(2500);
  const crash = B.output.join('').match(/Error: listen \w+[^\n]*/)?.[0] ?? '(no crash)';
  console.log(`2. B, same folder and port: ${crash}`);
  console.log("   A's run is now recorded as:", JSON.stringify(recorded(nodeId)));

  const C = start(Q);
  others.push(C);
  await ready(`http://127.0.0.1:${Q}`);
  const second = await api(`http://127.0.0.1:${Q}`, 'POST', `/api/nodes/${nodeId}/runs`, {
    prompt: 'a second run on the same experiment',
  });
  console.log(
    `3. C, same folder, another port, starts a run on it while A still runs it: HTTP ${second.status}`,
  );

  for (let i = 0; i < 60 && recorded(nodeId).runs.some((r) => r.status === 'running'); i++)
    await delay(1000);
  await delay(1500);
  console.log('4. When both have finished:', JSON.stringify(recorded(nodeId), null, 2));
} finally {
  for (const copy of [A, ...others]) copy.child.kill('SIGKILL');
  await delay(500);
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
