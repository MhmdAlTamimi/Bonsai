import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { Settings } from '../settings.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import type { RunSpec, ComparisonSpec, DraftRequest, RunEvent } from '../agent/AgentRunner.js';
import { OperationConflict } from '../domain/errors.js';
import { EventBus } from '../api/events.js';
import { Connection } from '../api/connectionGate.js';
import { handleApi } from '../api/router.js';
import { createProject, createChildNode } from '../projects.js';
import { silentLogger } from '../log.js';
import { RunJobs } from './runNode.js';
import { ComparisonJobs } from './comparisons.js';
import { comparisonFolder } from './comparisonSnapshot.js';
import { ExecutionPool } from './executionPool.js';

type Kind = 'run' | 'comparison' | 'draft';
class HeldRunner extends FakeRunner {
  started: Kind[] = [];
  peak = 0;
  private live = 0;
  private releases = new Map<Kind, () => void>();
  cleanup: ((path: string) => Promise<void>) | null = null;
  private enter(kind: Kind): void {
    this.started.push(kind);
    this.live += 1;
    this.peak = Math.max(this.peak, this.live);
  }
  private hold(kind: Kind, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', abort);
        this.releases.delete(kind);
        resolve();
      };
      const abort = (): void => {
        setTimeout(finish, 20);
      };
      this.releases.set(kind, finish);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
  release(kind: Kind): void {
    this.releases.get(kind)?.();
  }
  override async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.enter('run');
    try {
      if (spec.prompt !== 'fast') await this.hold('run', spec.signal);
      if (!spec.signal.aborted) yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 };
    } finally {
      this.live -= 1;
    }
  }
  override async *compare(spec: ComparisonSpec): AsyncIterable<RunEvent> {
    this.enter('comparison');
    try {
      await this.hold('comparison', spec.signal);
      if (spec.signal.aborted && this.cleanup) await this.cleanup(spec.cwd);
      if (!spec.signal.aborted) yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 };
    } finally {
      this.live -= 1;
    }
  }
  override async draft(request: DraftRequest): Promise<string> {
    this.enter('draft');
    try {
      await this.hold('draft', request.signal);
      if (request.signal.aborted) throw new OperationConflict('Draft cancelled.');
      return 'drafted reference';
    } finally {
      this.live -= 1;
    }
  }
}
let dir: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
let pool: ExecutionPool;
let jobs: RunJobs;
let comparisons: ComparisonJobs;
let runner: HeldRunner;
let server: Server;
let base: string;
let projectId: string;
let ids: string[];
const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'expected job state within deadline');
};
const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bonsai-shared-jobs-'));
  db = openDatabase(dir);
  store = new Store(db, join(dir, 'repos'));
  const settings = new Settings({
    port: 0,
    dataDir: dir,
    reposRoot: join(dir, 'repos'),
    defaultModel: null,
    defaultPermissionMode: 'acceptEdits',
  });
  settings.update({ maxConcurrentRuns: 1 });
  const bus = new EventBus();
  runner = new HeldRunner();
  pool = new ExecutionPool(() => settings.maxConcurrentRuns());
  jobs = new RunJobs(store, bus, runner, settings, silentLogger, undefined, pool);
  comparisons = new ComparisonJobs(store, bus, runner, settings, silentLogger, pool);
  const connection = new Connection(settings, true);
  await connection.check();
  server = createServer((req, res) => {
    void handleApi(req, res, {
      store,
      jobs,
      comparisons,
      conversations: runner,
      drafts: runner,
      bus,
      settings,
      connection,
      log: silentLogger,
    }).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = await createProject(store, {
    name: 'shared jobs',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  projectId = project.projectId;
  ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (
        await createChildNode(store, {
          projectId,
          parentId: project.masterNodeId,
          displayName: `experiment ${i}`,
          description: '',
        })
      ).nodeId,
    );
  store.appendMessage({
    nodeId: ids[0]!,
    runId: null,
    role: 'assistant',
    kind: 'text',
    content: 'Conversation to draft from.',
  });
});
afterEach(async () => {
  for (const job of pool.jobs()) job.controller.abort();
  await until(() => pool.jobs().length === 0);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const compare = () =>
  comparisons.create(
    projectId,
    ids.slice(0, 2).map((id) => store.getNode(id)!),
  );

test('runs, comparisons and drafts share a single FIFO bound through the HTTP API', async () => {
  const row = await compare();
  jobs.start(ids[0]!, 'held');
  await until(() => runner.started.length === 1);
  assert.equal(
    (await post(`/api/comparisons/${row.id}/messages`, { prompt: 'compare' })).status,
    202,
  );
  const draft = post('/api/references/draft', { nodeId: ids[0], instruction: 'summarize' });
  await until(() => pool.jobs().length === 3);
  jobs.start(ids[2]!, 'fast');
  assert.equal(jobs.queuePosition(ids[2]!), 3);
  assert.match(jobs.queueReason(ids[2]!) ?? '', /active job/);
  const view = (await (await fetch(`${base}/api/comparisons/${row.id}`)).json()) as {
    queuePosition: number;
  };
  assert.equal(view.queuePosition, 1);
  await assert.rejects(
    pool.exclusivelyWhenIdle(() => Promise.resolve()),
    /must be idle/,
  );
  assert.equal((await post('/api/backup', {})).status, 409);
  runner.release('run');
  await until(() => runner.started.length === 2);
  assert.deepEqual(runner.started, ['run', 'comparison']);
  assert.match(jobs.queueReason(ids[2]!) ?? '', /comparison or reference draft/);
  runner.release('comparison');
  await until(() => runner.started.length === 3);
  runner.release('draft');
  assert.equal((await draft).status, 200);
  await until(() => pool.jobs().length === 0);
  assert.deepEqual(runner.started, ['run', 'comparison', 'draft', 'run']);
  assert.equal(runner.peak, 1);
});
test('project deletion cancels queued jobs and waits for active comparison cleanup before removing files or rows', async () => {
  const row = await compare();
  comparisons.ask(row.id, 'held');
  await until(() => runner.started.length === 1);
  let cleaned = false;
  runner.cleanup = async (path) => {
    assert.ok(store.comparisons.get(row.id));
    await writeFile(join(path, 'cleanup.txt'), 'finished while owned');
    cleaned = true;
  };
  const draft = post('/api/references/draft', { nodeId: ids[0], instruction: 'summarize' });
  await until(() => pool.jobs().length === 2);
  jobs.start(ids[2]!, 'queued');
  const response = await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await draft).status, 409);
  assert.equal(cleaned, true);
  assert.equal(pool.jobs().length, 0);
  assert.equal(store.getProject(projectId), undefined);
  assert.deepEqual(runner.started, ['comparison']);
  assert.equal(existsSync(comparisonFolder(store, projectId, row.id)), false);
});
test('deleting a comparison waits for its final write and retains the project', async () => {
  const row = await compare();
  comparisons.ask(row.id, 'held');
  await until(() => runner.started.length === 1);
  let cleaned = false;
  runner.cleanup = async (path) => {
    assert.ok(store.comparisons.get(row.id));
    await writeFile(join(path, 'cleanup.txt'), 'owned');
    cleaned = true;
  };
  assert.equal(
    (await fetch(`${base}/api/comparisons/${row.id}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal(cleaned, true);
  assert.equal(store.comparisons.get(row.id), undefined);
  assert.ok(store.getProject(projectId));
});
test('an idle maintenance snapshot blocks API writes and always releases the gate on failure', async () => {
  await assert.rejects(
    pool.exclusivelyWhenIdle(async () => {
      assert.equal(
        (await post('/api/projects', { name: 'must not create', description: '' })).status,
        409,
      );
      assert.throws(() => jobs.start(ids[0]!, 'must not start'), /backup/);
      await assert.rejects(
        jobs.whileIdle(ids[0]!, () => Promise.resolve()),
        /backup/,
      );
      throw new Error('fixture snapshot failure');
    }),
    /fixture snapshot failure/,
  );
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.listRuns(ids[0]!).length, 0);
  assert.equal(
    (await post('/api/projects', { name: 'gate reopened', description: '' })).status,
    201,
  );
});
