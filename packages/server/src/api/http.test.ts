import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { Settings } from '../settings.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import { RunJobs } from '../jobs/runNode.js';
import { ComparisonJobs } from '../jobs/comparisons.js';
import { silentLogger } from '../log.js';
import { Connection } from './connectionGate.js';
import { EventBus } from './events.js';
import { handleApi } from './router.js';

test('HTTP routes validate requests, persist accepted runs, and stream project events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-http-'));
  const db = openDatabase(dir);
  const store = new Store(db, join(dir, 'repos'));
  const settings = new Settings({
    port: 0,
    dataDir: dir,
    reposRoot: join(dir, 'repos'),
    defaultModel: null,
    defaultPermissionMode: 'acceptEdits',
  });
  const runner = new FakeRunner();
  const connection = new Connection(settings, true);
  await connection.check();
  const bus = new EventBus();
  const jobs = new RunJobs(store, bus, runner, settings);
  const comparisons = new ComparisonJobs(store, bus, runner, settings, silentLogger);
  const server = createServer((req, res) => {
    void handleApi(req, res, {
      store,
      buildId: 'current-build',
      settings,
      connection,
      bus,
      jobs,
      comparisons,
      conversations: runner,
      drafts: runner,
      log: silentLogger,
    })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + '/api/not-a-route')).status, 404);
    const version = await fetch(base + '/api/version');
    assert.deepEqual(await version.json(), { buildId: 'current-build' });
    assert.equal(version.headers.get('x-bonsai-build'), 'current-build');
    const stale = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bonsai-build': 'old-build' },
      body: JSON.stringify({ name: 'Must not create', description: '' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(
      store.listProjects().length,
      0,
      'a mismatched frontend cannot mutate the upgraded server',
    );
    assert.equal(
      (await fetch(base + '/api/projects', { headers: { 'x-bonsai-build': 'old-build' } })).status,
      200,
      'saved work stays readable',
    );

    assert.equal(
      (await fetch(base + '/api/settings', { headers: { origin: 'https://example.com' } })).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(base + '/api/projects', {
          method: 'POST',
          headers: { origin: 'http://localhost:9999' },
        })
      ).status,
      403,
      'a simple bodyless POST from an unrelated local website is rejected before routing',
    );
    assert.equal((await post('/api/projects', [])).status, 400);
    assert.equal((await post('/api/projects', {})).status, 400);
    const created = await post('/api/projects', { name: 'HTTP fixture', description: '' });
    assert.equal(created.status, 201);
    const project = (await created.json()) as { projectId: string; masterNodeId: string };
    assert.equal((await fetch(`${base}/api/projects/${project.projectId}/tree`)).status, 200);

    const stream = new AbortController();
    const response = await fetch(`${base}/api/events?projectId=${project.projectId}`, {
      signal: stream.signal,
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/);
    bus.publish(project.projectId, { type: 'tree.updated', projectId: project.projectId });
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: tree.updated/);
    stream.abort();

    // Shared browser transport carries the project identity; finite polling
    // observes changes even when no event stream is connected.
    const check = async (id: string): Promise<string> => {
      const result = await fetch(`${base}/api/events/check?projectId=${id}`);
      assert.equal(result.status, 200);
      return ((await result.json()) as { revision: string }).revision;
    };
    const before = await check(project.projectId);
    const otherBefore = await check('other-project');
    const shared = new AbortController();
    const sharedResponse = await fetch(`${base}/api/events?all=1`, { signal: shared.signal });
    const sharedReader =
      sharedResponse.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await sharedReader.read();
    const event = {
      type: 'tree.updated' as const,
      projectId: project.projectId,
      nodeId: project.masterNodeId,
    };
    bus.publish(project.projectId, event);
    const frame = new TextDecoder().decode((await sharedReader.read()).value);
    assert.match(frame, /event: event/);
    assert.ok(frame.includes(JSON.stringify({ projectId: project.projectId, event })));
    shared.abort();
    assert.notEqual(await check(project.projectId), before);
    assert.equal(await check('other-project'), otherBefore);
    const disconnected = await check(project.projectId);
    bus.publish(project.projectId, event);
    assert.notEqual(await check(project.projectId), disconnected);
    assert.notEqual(new EventBus().revision(project.projectId), bus.revision(project.projectId));

    const accepted = await post(`/api/nodes/${project.masterNodeId}/runs`, {
      prompt: 'HTTP durable request',
    });
    assert.equal(accepted.status, 202);
    const run = (await accepted.json()) as { runId: string };
    assert.equal(store.runs.requestOf(run.runId)?.prompt, 'HTTP durable request');
    assert.equal(store.lastUserPrompt(project.masterNodeId), 'HTTP durable request');
    const deadline = Date.now() + 10000;
    while (jobs.isRunning(project.masterNodeId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.getRun(run.runId)?.status, 'done');
    assert.equal(store.getNode(project.masterNodeId)?.status, 'ready');
    const node = store.getNode(project.masterNodeId)!;
    await rm(node.worktree_path, { recursive: true });
    assert.equal(
      (await fetch(`${base}/api/runs/${run.runId}/diff`)).status,
      200,
      'committed run changes remain readable without a checkout',
    );
    const missing = await fetch(`${base}/api/nodes/${node.id}`);
    assert.equal(
      missing.status,
      200,
      'recovery must remain reachable when the checkout is missing',
    );
    const detail = (await missing.json()) as {
      gitRecovery: { problem: string; version: string };
      partialWork: unknown;
    };
    assert.equal(detail.gitRecovery.problem, 'missing_folder');
    assert.equal(detail.partialWork, null);
    assert.equal(
      (await post(`/api/nodes/${node.id}/synchronize`, { action: 'restore', version: 'stale' }))
        .status,
      409,
    );
    assert.equal(
      (
        await post(`/api/nodes/${node.id}/synchronize`, {
          action: 'restore',
          version: detail.gitRecovery.version,
        })
      ).status,
      200,
    );
    assert.equal((await post(`/api/nodes/${node.id}/export`, {})).status, 201);
  } finally {
    bus.closeAll();
    await jobs.drain();
    await comparisons.drain();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
