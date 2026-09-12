import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createChildNode, createProject } from '../projects.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * Stopping a run.
 *
 * The bug this exists for was not in the runner -- cancellation always worked
 * -- but in the shape of the route. Cancel was addressed by run id, so the
 * interface had to know which run was in flight, which it learned from a fetch
 * that might not have landed yet. Press stop early and nothing happened, with
 * no error, while the agent carried on spending.
 *
 * So what is asserted here is that cancelling by NODE needs nothing but the
 * node: no run id, no fetched detail, and no particular moment.
 */
class SlowRunner implements AgentRunner {
  started = 0;

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.started += 1;
    yield { type: 'session', sessionId: `s-${this.started}` };
    // Hangs until aborted, which is what a real run looks like from the
    // outside for the seconds that matter here.
    await new Promise<void>((resolve) => {
      if (spec.signal.aborted) return resolve();
      spec.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'error', error: 'cancelled mid-run' };
  }
}

describe('cancelling a run', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: SlowRunner;
  let projectId: string;
  let masterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-cancel-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new SlowRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    projectId = created.projectId;
    masterId = created.masterNodeId;
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Waits for the pipeline to unwind, which outlives the abort signal. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 200 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test('a node can be cancelled the instant it starts, with only its id', async () => {
    jobs.start(masterId, 'do something slow');
    assert.equal(store.getNode(masterId)!.status, 'running');

    // No run id, no fetched detail, no waiting for anything to arrive. This is
    // the whole point: there is no window where stop is a silent no-op.
    assert.equal(jobs.cancel(masterId), true);
    await settle();

    assert.equal(store.getNode(masterId)!.status, 'interrupted');
    const run = store.listRuns(masterId)[0]!;
    assert.equal(run.status, 'cancelled');
  });

  test('cancelling a node that is not running is false, not an error', async () => {
    // The route returns 200 with this. "It already stopped" is not a failure,
    // and making it one would put an error banner in front of the user for
    // pressing stop twice.
    assert.equal(jobs.cancel(masterId), false);
    assert.equal(store.getNode(masterId)!.status, 'new');
  });

  test('a cancelled run commits nothing', async () => {
    const before = store.getNode(masterId)!.head_commit;
    jobs.start(masterId, 'do something slow');
    jobs.cancel(masterId);
    await settle();

    // Master had a root commit before the run; cancelling must not have added
    // to it, and must not have created a branch for work that never finished.
    assert.equal(store.listRuns(masterId)[0]!.commitSha, null);
    assert.equal(store.getNode(masterId)!.head_commit, before);
  });

  test('several nodes in flight are stopped independently', async () => {
    const a = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'a',
      description: '',
    });
    const b = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'b',
      description: '',
    });

    jobs.start(a.nodeId, 'slow a');
    jobs.start(b.nodeId, 'slow b');
    assert.equal(jobs.activeCount(), 2);

    assert.equal(jobs.cancel(a.nodeId), true);
    await settle();

    assert.equal(store.getNode(a.nodeId)!.status, 'interrupted');
    // b is untouched -- stop-all is a loop over this, not a different mechanism.
    assert.equal(store.getNode(b.nodeId)!.status, 'running');

    assert.equal(jobs.cancel(b.nodeId), true);
    await settle();
    assert.equal(store.getNode(b.nodeId)!.status, 'interrupted');
    assert.equal(jobs.activeCount(), 0);
  });
});
