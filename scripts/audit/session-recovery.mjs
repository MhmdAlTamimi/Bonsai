/** Real bundled SDK recovery, always isolated behind the verified fake API. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeApi } from './fake-api.mjs';
import { delay, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-session-recovery-'));
const home = join(root, 'fake-home');
await mkdir(home);
let data = join(root, 'data');
const fake = await startFakeApi({ captureMessages: true });
let bonsai;
const connect = async () => {
  bonsai = await startBonsai(
    data,
    { HOME: home, ANTHROPIC_BASE_URL: fake.url },
    { realAgent: true },
  );
  assert.equal(
    (
      await bonsai.api('PATCH', '/api/settings', {
        authMode: 'api_key',
        apiKey: 'sk-ant-api03-audit-fake',
      })
    ).status,
    200,
  );
  assert.equal((await bonsai.api('POST', '/api/connection/check')).body.state, 'connected');
};
const database = (fn) => {
  const db = new DatabaseSync(join(data, 'bonsai.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const session = (id) =>
  database((db) => db.prepare('SELECT session_id FROM node WHERE id = ?').get(id).session_id);
const run = async (id, prompt, file) => {
  fake.script(...(file ? [`bash:printf session-fixture > ${file}`] : []), 'text');
  assert.equal((await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt })).status, 202);
  const detail = (await bonsai.settle(id)).body;
  assert.equal(detail.runs.at(-1).status, 'done', detail.runs.at(-1).error);
  return detail;
};
const ask = async (id, prompt) => {
  fake.script('text');
  assert.equal(
    (await bonsai.api('POST', `/api/comparisons/${id}/messages`, { prompt })).status,
    202,
  );
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const detail = (await bonsai.api('GET', `/api/comparisons/${id}`)).body;
    if (detail.turns.at(-1)?.status !== 'running') {
      assert.equal(detail.turns.at(-1).status, 'done', detail.turns.at(-1).error);
      return detail;
    }
    await delay(100);
  }
  throw new Error('Comparison failed to settle');
};
try {
  await connect();
  const project = (
    await bonsai.api('POST', '/api/projects', { name: 'session fixture', description: '' })
  ).body;
  await run(project.masterNodeId, 'remember original-context-canary and create a.txt', 'a.txt');
  const original = session(project.masterNodeId);
  assert.ok(
    database(
      (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM sdk_session_entry WHERE session_id = ?').get(original)
          .n,
    ) > 0,
  );
  await bonsai.stop('SIGTERM');
  await rm(join(home, '.claude', 'projects'), { recursive: true, force: true });
  await connect();
  await run(project.masterNodeId, 'continue using the saved context');
  assert.equal(
    session(project.masterNodeId),
    original,
    'resume must use the durable mirror after global files are gone',
  );
  const made = await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
    parentId: project.masterNodeId,
    displayName: 'child',
    description: '',
  });
  assert.equal(made.status, 201);
  const child = made.body.node.id;
  const inherited = session(child);
  assert.ok(inherited && inherited !== original);
  await run(child, 'create b.txt using inherited context', 'b.txt');
  assert.equal(session(child), inherited);
  const comparison = await bonsai.api('POST', `/api/projects/${project.projectId}/comparisons`, {
    nodeIds: [project.masterNodeId, child],
  });
  assert.equal(comparison.status, 201);
  const compared = await ask(comparison.body.id, 'compare both approaches');
  const comparisonSession = database(
    (db) =>
      db.prepare('SELECT session_id FROM comparison WHERE id = ?').get(compared.id).session_id,
  );
  // Recreate a valid legacy global file from the actual SDK transcript. Only
  // this owned mirror is removed; SDK-store resumes can use temporary files.
  const legacy = database((db) => ({
    cwd: db.prepare('SELECT worktree_path FROM node WHERE id = ?').get(child).worktree_path,
    transcript:
      db
        .prepare(
          'SELECT data_json FROM sdk_session_entry WHERE session_id = ? AND subpath = ? ORDER BY id',
        )
        .all(inherited, '')
        .map((row) => row.data_json)
        .join('\n') + '\n',
  }));
  const legacyFolder = join(home, '.claude', 'projects', legacy.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(legacyFolder, { recursive: true });
  await writeFile(join(legacyFolder, `${inherited}.jsonl`), legacy.transcript);
  database((db) => {
    db.prepare('DELETE FROM sdk_session WHERE session_id = ?').run(inherited);
    db.prepare('DELETE FROM meta WHERE key = ?').run(`session_boundary:${child}`);
  });
  const backup = await bonsai.api('POST', '/api/backup');
  assert.equal(backup.status, 201, JSON.stringify(backup.body));
  assert.equal(backup.body.conversationFallbacks, 0);
  assert.ok(
    database(
      (db) =>
        db
          .prepare('SELECT COUNT(*) AS n FROM sdk_session_entry WHERE session_id = ?')
          .get(inherited).n,
    ) > 0,
    'backup imports available legacy sessions before the database snapshot',
  );
  await bonsai.stop('SIGTERM');
  const restored = join(root, 'restored');
  await rename(backup.body.path, restored);
  await rm(data, { recursive: true, force: true });
  await rm(join(home, '.claude', 'projects'), { recursive: true, force: true });
  data = restored;
  await connect();
  await run(child, 'continue after independent backup restore');
  assert.equal(session(child), inherited);
  await ask(compared.id, 'continue the comparison after restore');
  assert.equal(
    database(
      (db) =>
        db.prepare('SELECT session_id FROM comparison WHERE id = ?').get(compared.id).session_id,
    ),
    comparisonSession,
  );
  const absent = randomUUID();
  database((db) =>
    db
      .prepare('UPDATE node SET session_id = ?, session_position = NULL WHERE id = ?')
      .run(absent, child),
  );
  const compact = await bonsai.api('POST', `/api/nodes/${child}/compact`, {});
  assert.equal(compact.status, 409);
  assert.match(compact.body.error, /normal message/);
  await run(child, 'new request after lost legacy session');
  assert.notEqual(session(child), absent);
  assert.ok(
    (await bonsai.api('GET', `/api/nodes/${child}/messages`)).body.some(
      (message) => message.role === 'system' && String(message.content).includes('saved history'),
    ),
  );
  assert.ok(
    fake.requests.some(
      (request) =>
        request.mainLoop &&
        JSON.stringify(request.messages).includes('original-context-canary') &&
        JSON.stringify(request.messages).includes('Bonsai saved conversation'),
    ),
  );
  console.log(
    'PASS: durable SDK resume, fixed child fork, moved independent backup, comparison resume, compact refusal and explicit saved-history recovery',
  );
} finally {
  await bonsai?.stop('SIGTERM');
  await fake.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
