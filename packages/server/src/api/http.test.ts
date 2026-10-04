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
