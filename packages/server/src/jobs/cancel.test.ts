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

  test('cancelling a node that is not running is false, not an error', () => {
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

/**
 * The concurrency cap.
 *
 * "Run several experiments at once" is the product, so an unbounded start is
 * not generous, it is the worst first impression available: ten agents do not
 * finish ten times sooner, they contend until the machine stops answering.
 *
 * What is asserted below is the shape the brief asks for -- three run, two
 * wait, the waiting ones start as slots free -- plus the two things that make
 * a queue safe rather than a trap: a queued run can be cancelled, and doing so
 * must not strand its node in `running` for ever.
 */
describe('the run queue', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: SlowRunner;
  let projectId: string;
  let masterId: string;
  let limit = 3;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-queue-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new SlowRunner();
    limit = 3;
    jobs = new RunJobs(store, new EventBus(), runner, {
      model: () => null,
      effort: () => null,
      agentEnv: () => null,
      maxConcurrentRuns: () => limit,
    });
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

  async function fiveChildren(): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { nodeId } = await createChildNode(store, {
        projectId,
        parentId: masterId,
        displayName: `n${i}`,
        description: '',
      });
      ids.push(nodeId);
    }
    return ids;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Lets the dispatched jobs get past their (empty) setup phase. */
  async function tick(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }

  test('five runs with a cap of three: three run, two queue', async () => {
    const ids = await fiveChildren();
    for (const id of ids) jobs.start(id, 'slow');

    // Slots are taken synchronously, which is what stops five setups running
    // at once...
    assert.equal(jobs.activeCount(), 3);
    assert.equal(jobs.queuedCount(), 2);

    // ...but the agent itself starts after the node's setup phase, so it is a
    // turn behind. Nothing observable depends on the ordering; the count does.
    await tick();
    assert.equal(runner.started, 3, 'only three agents were actually started');

    // The two waiting ones are `running` to the state machine -- there is no
    // sixth status -- and carry a 1-based queue position instead.
    assert.equal(jobs.queuePosition(ids[3]!), 1);
    assert.equal(jobs.queuePosition(ids[4]!), 2);
    assert.equal(jobs.queuePosition(ids[0]!), null);
    for (const id of ids) assert.equal(store.getNode(id)!.status, 'running');
  });

  test('a queued run starts as soon as a slot frees', async () => {
    const ids = await fiveChildren();
    for (const id of ids) jobs.start(id, 'slow');

    jobs.cancel(ids[0]!);
    for (let i = 0; i < 200 && runner.started < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(runner.started, 4, 'the next queued run took the free slot');
    assert.equal(jobs.queuedCount(), 1);
    // And it moved up the queue rather than keeping its old number.
    assert.equal(jobs.queuePosition(ids[4]!), 1);
  });

  test('cancelling a queued run drops it, and does not strand the node', async () => {
    const ids = await fiveChildren();
    for (const id of ids) jobs.start(id, 'slow');

    assert.equal(jobs.cancel(ids[4]!), true);
    assert.equal(jobs.queuedCount(), 1);
    assert.equal(jobs.queuePosition(ids[4]!), null);
    // No agent ever ran for it, so nothing was aborted -- but the node must
    // not be left saying `running` for the rest of the session.
    assert.notEqual(store.getNode(ids[4]!)!.status, 'running');
    assert.equal(store.listRuns(ids[4]!)[0]!.status, 'cancelled');
    await tick();
    assert.equal(runner.started, 3, 'cancelling a queued run starts no agent');
  });

  test('raising the limit lets waiting runs through immediately', async () => {
    const ids = await fiveChildren();
    for (const id of ids) jobs.start(id, 'slow');
    assert.equal(jobs.queuedCount(), 2);

    limit = 5;
    // pump() runs when a slot frees; freeing one drains everything the new
    // limit allows, which is why it is a loop rather than a single take.
    jobs.cancel(ids[0]!);
    for (let i = 0; i < 200 && jobs.queuedCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(jobs.queuedCount(), 0);
  });

  test('everything drains, queued runs included', async () => {
    const ids = await fiveChildren();
    for (const id of ids) jobs.start(id, 'slow');

    await jobs.drain();
    await settle();

    assert.equal(jobs.activeCount(), 0);
    assert.equal(jobs.queuedCount(), 0);
    for (const id of ids) assert.notEqual(store.getNode(id)!.status, 'running');
  });
});
