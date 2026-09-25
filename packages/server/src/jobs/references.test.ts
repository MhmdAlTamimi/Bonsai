import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createProject } from '../projects.js';
import { readRunReference, fileNames } from './runContext.js';
import { attachedReferences } from '../api/references.js';
import { HttpError } from '../api/http.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * References reaching a run: as files the agent reads, fixed at the version
 * the run was given, and recorded so the conversation can show them later.
 */
class ReadingRunner implements AgentRunner {
  readonly specs: RunSpec[] = [];
  /** What each reference file held while the run was going. */
  readonly seen: string[] = [];
  private release: (() => void) | null = null;
  hold = false;

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
    yield { type: 'session', sessionId: spec.resumeSessionId ?? 'session-1' };
    for (const reference of spec.references ?? []) {
      this.seen.push(await readFile(reference.path, 'utf8'));
    }
    if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
    yield { type: 'text', text: 'done' };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  }

  go(): void {
    this.hold = false;
    this.release?.();
  }
}

describe('attaching references to a message', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: ReadingRunner;
  let projectId: string;
  let masterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-attach-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new ReadingRunner();
    jobs = new RunJobs(store, new EventBus(), runner, {
      model: () => null,
      effort: () => null,
      agentEnv: () => null,
      maxConcurrentRuns: () => 1,
    });
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    projectId = created.projectId;
    masterId = created.masterNodeId;
  });

  afterEach(async () => {
    runner.go();
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const settle = async (nodeId = masterId): Promise<void> => {
    for (let i = 0; i < 300 && jobs.isRunning(nodeId); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const add = (name: string, content: string) =>
    store.references.create({ projectId, name, content, sourceNodeId: null });

  test('the agent is given files to read, named after the references', async () => {
    const smoke = add('Smoke test', 'run npm test and report it');
    jobs.start(masterId, 'apply the smoke test', { referenceIds: [smoke.id] });
    await settle();

    const given = runner.specs[0]!.references!;
    assert.equal(given.length, 1);
    assert.equal(given[0]!.name, 'Smoke test');
    assert.match(given[0]!.path, /run-context[/\\][^/\\]+[/\\]references[/\\]smoke-test\.md$/);
    assert.deepEqual(runner.seen, ['run npm test and report it']);
    // Read-only on disk, so what a run was given is what it is shown later. (The
    // mode rather than a failed write: root, which CI and containers often are,
    // can write through it.)
    assert.equal((await stat(given[0]!.path)).mode & 0o777, 0o400);
  });

  test('a run keeps the version it was given after the reference is edited', async () => {
    const smoke = add('smoke', 'first version');
    jobs.start(masterId, 'go', { referenceIds: [smoke.id] });
    await settle();
    store.references.update(smoke.id, { content: 'second version' });

    const run = store.listRuns(masterId).at(-1)!;
    const recorded = run.resolvedContext!.references![0]!;
    assert.equal(recorded.name, 'smoke');
    assert.equal(recorded.size, 'first version'.length);
    assert.equal(await readRunReference(store, projectId, run.id, recorded), 'first version');
    assert.notEqual(
      recorded.revision,
      store.referenceView(store.references.get(smoke.id)!).revision,
    );
  });

  test('one deleted before its run starts is said, not silently dropped', async () => {
    const other = await import('../projects.js').then((m) =>
      m.createChildNode(store, {
        projectId,
        parentId: masterId,
        displayName: 'b',
        description: '',
      }),
    );
    const smoke = add('smoke', 'x');
    runner.hold = true;
    jobs.start(other.nodeId, 'occupy the only slot');
    jobs.start(masterId, 'queued with a reference', { referenceIds: [smoke.id] });
    store.references.delete(smoke.id);
    runner.go();
    await settle(other.nodeId);
    await settle();

    assert.deepEqual(runner.specs.at(-1)!.references, []);
    const note = store.listMessages(masterId, 0).find((m) => m.role === 'system');
    assert.match(String(note?.content), /deleted before this run started/);
  });

  test('a command carries none, and resuming carries what the interrupted run had', async () => {
    const smoke = add('smoke', 'x');
    jobs.start(masterId, '? first', { referenceIds: [smoke.id] });
    await settle();
    jobs.compact(masterId, null);
    await settle();
    assert.equal(runner.specs.at(-1)!.references?.length ?? 0, 0);

    runner.hold = true;
    jobs.start(masterId, 'long job', { referenceIds: [smoke.id] });
    for (let i = 0; i < 100 && runner.specs.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    jobs.cancel(masterId);
    runner.go();
    await settle();
    await jobs.startResume(masterId);
    await settle();
    assert.equal(runner.specs.at(-1)!.references?.[0]?.name, 'smoke');
  });

  test('only references from the same project can be attached', async () => {
    const elsewhere = await createProject(store, {
      name: 'other',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const foreign = store.references.create({
      projectId: elsewhere.projectId,
      name: 'foreign',
      content: 'x',
      sourceNodeId: null,
    });
    const mine = add('mine', 'x');
    assert.deepEqual(attachedReferences(store, projectId, [mine.id, mine.id]), [mine.id]);
    assert.throws(() => attachedReferences(store, projectId, [foreign.id]), HttpError);
    assert.throws(() => attachedReferences(store, projectId, 'not-a-list'), HttpError);
  });

  test('file names read at a glance and never collide within a run', () => {
    assert.deepEqual(fileNames(['Smoke test', 'smoke-test', '???', 'API: contract']), [
      'smoke-test.md',
      'smoke-test-2.md',
      'reference.md',
      'api-contract.md',
    ]);
  });
});
