import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RunActivity, ServerEvent } from '@bonsai/shared';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createProject } from '../projects.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * D43, the pipeline's half: a run waiting for background work is still a run.
 *
 * It shows what it is waiting for, Finish now ends it the ordinary way -- so
 * what it produced is committed -- and Stop still frees it. The runner's half,
 * deciding when a session is over, is in agent/session.test.ts.
 */
const TRAINING: RunActivity = {
  state: 'waiting',
  tool: null,
  background: [
    { id: 'b1', description: 'train', tracked: true, startedAt: '2026-09-16T12:00:00.000Z' },
  ],
};

/** Writes a result, then waits for its background job until Finish now or Stop. */
class WaitingRunner implements AgentRunner {
  spec!: RunSpec;
  waiting!: Promise<void>;
  private announce!: () => void;

  constructor() {
    this.waiting = new Promise((resolve) => (this.announce = resolve));
  }

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.spec = spec;
    yield { type: 'session', sessionId: 'waiting-session' };
    await writeFile(join(spec.cwd, 'results.csv'), 'epoch,loss\n1,0.5\n', 'utf8');
    spec.onActivity(TRAINING);
    this.announce();
    await new Promise<void>((resolve) => {
      for (const signal of [spec.signal, spec.finishNow]) {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      }
    });
    if (spec.signal.aborted) return;
    spec.onActivity({ state: 'working', tool: null, background: [] });
    yield { type: 'text', text: 'Stopped the training job and wrote up the results.' };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0.02 };
  }
}

class RecordingBus extends EventBus {
  readonly events: ServerEvent[] = [];
  override publish(projectId: string, event: ServerEvent): void {
    this.events.push(event);
    super.publish(projectId, event);
  }
}

describe('a run waiting for background work', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let bus: RecordingBus;
  let jobs: RunJobs;
  let runner: WaitingRunner;
  let nodeId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-background-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    bus = new RecordingBus();
    runner = new WaitingRunner();
    jobs = new RunJobs(store, bus, runner);
    nodeId = (
      await createProject(store, {
        name: 'p',
        description: '',
        model: null,
        permissionMode: 'acceptEdits',
      })
    ).masterNodeId;
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
  }

  test('says what it is waiting for, and stays running', async () => {
    jobs.start(nodeId, 'train the model');
    await runner.waiting;

    assert.deepEqual(jobs.activity(nodeId), TRAINING);
    assert.equal(store.getNode(nodeId)!.status, 'running', 'waiting is not a sixth status');
    assert.equal(store.listRuns(nodeId)[0]!.status, 'running');
    assert.ok(
      bus.events.some((e) => e.type === 'run.activity' && e.activity.state === 'waiting'),
      'the interface is told without refetching the tree',
    );
  });

  test('Finish now ends it normally, and what it produced is committed', async () => {
    jobs.start(nodeId, 'train the model');
    await runner.waiting;

    assert.equal(jobs.finish(nodeId), true);
    await settle();

    const run = store.listRuns(nodeId)[0]!;
    assert.equal(run.status, 'done');
    assert.equal(run.endReason, 'finished');
    assert.equal(run.stoppedBackground, 1, 'the training job it stopped is counted');
    assert.notEqual(run.commitSha, null, 'the results were committed');
    // This run's own change: results.csv, and the CONTEXT.md written for it.
    assert.deepEqual(run.change, { files: 2, added: run.change!.added, removed: 0 });
    assert.equal(store.getNode(nodeId)!.status, 'ready');
    assert.equal(jobs.activity(nodeId), null, 'nothing is live once the run is over');
    const transcript = store
      .listMessages(nodeId, 0)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    assert.match(
      transcript,
      /Finish now: stopping the background job \(train\) and ending the run\./,
    );
  });

  test('Stop while waiting cancels it and frees the slot', async () => {
    const before = store.getNode(nodeId)!.head_commit;
    jobs.start(nodeId, 'train the model');
    await runner.waiting;

    assert.equal(jobs.cancel(nodeId), true);
    await settle();

    assert.equal(jobs.activeCount(), 0);
    assert.equal(store.listRuns(nodeId)[0]!.status, 'cancelled');
    assert.equal(store.listRuns(nodeId)[0]!.endReason, 'stopped');
    assert.equal(store.listRuns(nodeId)[0]!.error, null, 'a stop is not an error');
    assert.equal(store.getNode(nodeId)!.head_commit, before, 'a stopped run commits nothing');
    assert.equal(jobs.activity(nodeId), null);
  });

  test('a run cut off by the app closing is recorded as that, not as a stop', async () => {
    jobs.start(nodeId, 'train the model');
    await runner.waiting;
    await jobs.drain();
    assert.equal(store.listRuns(nodeId)[0]!.endReason, 'app_closed');
  });

  test('there is nothing to finish when nothing is running', () => {
    assert.equal(jobs.finish(nodeId), false);
  });

  test('activity goes out at most once a second, and the latest state is not lost', async () => {
    jobs.start(nodeId, 'train the model');
    await runner.waiting;
    const sent = (): RunActivity[] =>
      bus.events.flatMap((e) => (e.type === 'run.activity' ? [e.activity] : []));
    const before = sent().length;

    // A burst, as a run calling several quick tools produces.
    for (const detail of ['a.py', 'b.py', 'c.py']) {
      runner.spec.onActivity({
        state: 'working',
        tool: { name: 'Read', detail, startedAt: '2026-09-16T12:00:01.000Z' },
        background: [],
      });
    }
    assert.equal(sent().length, before, 'nothing more within the same second');

    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(sent().length, before + 1, 'one trailing update');
    assert.equal(sent().at(-1)?.tool?.detail, 'c.py', 'carrying the latest state');
  });
});
