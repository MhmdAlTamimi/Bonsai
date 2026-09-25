import { existsSync } from 'node:fs';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
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
 * D16 -- session forking, which is what the M3 checkpoint turns on.
 *
 * Uses a recording runner rather than the SDK: what has to be right is WHICH
 * session each run inherits and whether it forks, and that is decided entirely
 * by the pipeline. Asserting it here costs nothing and needs no credentials.
 */
class RecordingRunner implements AgentRunner {
  readonly specs: RunSpec[] = [];
  onRun: ((spec: RunSpec) => void) | null = null;
  constructor(private readonly writes = true) {}

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
    this.onRun?.(spec);
    // A fork gets a new session id; a resume keeps the one it was handed.
    const sessionId =
      spec.resumeSessionId !== null && !spec.forkSession
        ? spec.resumeSessionId
        : `session-${this.specs.length}`;
    yield { type: 'session', sessionId };
    yield { type: 'text', text: `handled: ${spec.prompt}` };
    // Same convention as the stand-in: a prompt starting with '?' answers
    // without writing, so the node stays conversation-only.
    const question = spec.prompt.trimStart().startsWith('?');
    if (this.writes && !spec.readOnly && !question) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(spec.cwd, `${this.specs.length}.txt`), 'x', 'utf8');
    }
    yield { type: 'done', inputTokens: 10, outputTokens: 5, costUsd: 0.01 };
  }
}

const settle = async (jobs: RunJobs, nodeId: string): Promise<void> => {
  for (let i = 0; i < 200 && jobs.isRunning(nodeId); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('session inheritance (D16)', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: RecordingRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-m3-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new RecordingRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const project = async () =>
    createProject(store, {
      name: 'p',
      description: 'd',
      model: null,
      permissionMode: 'acceptEdits',
    });

  const run = async (nodeId: string, prompt: string): Promise<void> => {
    jobs.start(nodeId, prompt);
    await settle(jobs, nodeId);
  };

  test("master's first run starts a fresh session", async () => {
    const { masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    assert.equal(runner.specs[0]!.resumeSessionId, null);
    assert.equal(runner.specs[0]!.forkSession, false);
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
  });

  test('chatting with the same node RESUMES its own session, never forks', async () => {
    const { masterNodeId } = await project();
    await run(masterNodeId, 'first');
    await run(masterNodeId, 'second');
    // §6.3: three chats with a leaf are one conversation.
    assert.equal(runner.specs[1]!.resumeSessionId, 'session-1');
    assert.equal(runner.specs[1]!.forkSession, false);
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
  });

  test('creation is metadata-only, first run allocates the pinned code, and parent remains writable', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'base');
    const child = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'later',
      description: '',
    });
    const node = store.getNode(child.nodeId)!;
    assert.equal(existsSync(node.worktree_path), false);
    assert.equal(store.listRuns(node.id).length, 0);
    await run(masterNodeId, 'parent advances');
    assert.equal(store.baseDiverges(store.getNode(node.id)!), true);
    await run(node.id, 'child changes');
    assert.equal(existsSync(node.worktree_path), true);
    assert.equal(store.getNode(node.id)!.base_commit, node.base_commit);
    assert.equal(store.treeView(projectId).find((n) => n.id === masterNodeId)?.writable, true);
    const before = store.getNode(masterNodeId)!.head_commit;
    await run(masterNodeId, 'parent continues after child commit');
    assert.notEqual(store.getNode(masterNodeId)!.head_commit, before);
  });

  test('each run refreshes parent context without losing child history or altering old snapshots', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, '? first parent turn');
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    await run(nodeId, '? first child turn');
    const first = store.listRuns(nodeId).at(-1)!.resolvedContext!;
    const firstText = await readFile(first.snapshotPath!, 'utf8');
    assert.match(firstText, /first parent turn/);
    const session = store.getNode(nodeId)!.session_id;
    await run(masterNodeId, '? latest parent turn');
    await run(nodeId, '? second child turn');
    const latest = store.listRuns(nodeId).at(-1)!.resolvedContext!;
    assert.ok(latest.parentMessageSeq > first.parentMessageSeq);
    assert.match(await readFile(latest.snapshotPath!, 'utf8'), /latest parent turn/);
    assert.equal(await readFile(first.snapshotPath!, 'utf8'), firstText);
    assert.equal(runner.specs.at(-1)!.resumeSessionId, session);
    assert.equal(runner.specs.at(-1)!.forkSession, false);
    assert.equal(runner.specs.at(-1)!.parentContextPath, latest.snapshotPath);
  });

  test('parent turns and edited goals after execution begins cannot change its resolved context', async () => {
    const { projectId, masterNodeId } = await project();
    const child = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'fixed',
      description: '',
      successCriteria: 'original goal',
    });
    runner.onRun = (spec) => {
      if (spec.nodeId !== child.nodeId) return;
      store.appendMessage({
        nodeId: masterNodeId,
        runId: null,
        role: 'user',
        kind: 'text',
        content: 'parent changed after execution began',
      });
      store.updateNode(child.nodeId, { successCriteria: 'next goal' });
    };
    await run(child.nodeId, '? begin');
    const context = store.listRuns(child.nodeId).at(-1)!.resolvedContext!;
    assert.equal(context.successCriteria, 'original goal');
    assert.doesNotMatch(
      await readFile(context.snapshotPath!, 'utf8'),
      /parent changed after execution began/,
    );
    runner.onRun = null;
    await run(child.nodeId, '? next');
    const next = store.listRuns(child.nodeId).at(-1)!.resolvedContext!;
    assert.equal(next.successCriteria, 'next goal');
    assert.match(
      await readFile(next.snapshotPath!, 'utf8'),
      /parent changed after execution began/,
    );
  });

  test('a question parent supplies conversation while code remains pinned to its ancestor', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'code');
    const question = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'question',
      description: '',
    });
    await run(question.nodeId, '? why this code');
    const child = await createChildNode(store, {
      projectId,
      parentId: question.nodeId,
      displayName: 'answer',
      description: '',
    });
    await run(child.nodeId, '? use the answer');
    const context = store.listRuns(child.nodeId).at(-1)!.resolvedContext!;
    assert.equal(context.parentNodeId, question.nodeId);
    assert.equal(context.codeCommit, store.getNode(masterNodeId)!.head_commit);
    assert.match(await readFile(context.snapshotPath!, 'utf8'), /why this code/);
  });

  test('allocation failure retains the experiment and releases the execution slot', async () => {
    const { projectId, masterNodeId } = await project();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'blocked',
      description: '',
    });
    const node = store.getNode(nodeId)!;
    await mkdir(node.worktree_path, { recursive: true });
    await writeFile(join(node.worktree_path, 'keep'), 'external work');
    await run(nodeId, 'try');
    assert.equal(store.listRuns(nodeId).at(-1)?.status, 'failed');
    assert.equal(jobs.activeCount(), 0);
    assert.equal(await readFile(join(node.worktree_path, 'keep'), 'utf8'), 'external work');
    assert.ok(store.getNode(nodeId));
  });
});

/**
 * The definition of done reaching the agent.
 *
 * Asserted at the pipeline rather than in the SDK runner because that is where
 * it could go missing: the criteria live on the NODE, and the easy mistake is
 * to send them only on the run that created it. A later message ("actually use
 * a set here") must not quietly drop the definition of done.
 */
describe('success criteria (2.1)', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: RecordingRunner;
  let projectId: string;
  let masterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-criteria-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new RecordingRunner();
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

  async function settle(): Promise<void> {
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  test('travel with every run of the node, not just the first', async () => {
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'fast search',
      description: 'make search fast',
      successCriteria: 'the /search endpoint answers in under 100ms',
      verificationHint: 'pytest tests/test_search.py',
    });

    jobs.start(nodeId, 'do it');
    await settle();
    jobs.start(nodeId, 'actually, use a set');
    await settle();

    assert.equal(runner.specs.length, 2);
    for (const spec of runner.specs) {
      assert.equal(spec.successCriteria, 'the /search endpoint answers in under 100ms');
      assert.equal(spec.verificationHint, 'pytest tests/test_search.py');
    }
  });

  test('a node created without them is unchanged', async () => {
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'plain',
      description: 'just do a thing',
    });
    jobs.start(nodeId, 'go');
    await settle();

    // Null, not empty string: nothing downstream should have to guess whether
    // '' means "no answer" or "the answer is nothing".
    assert.equal(runner.specs[0]!.successCriteria, null);
    assert.equal(runner.specs[0]!.verificationHint, null);
  });

  test('whitespace-only answers count as no answer', async () => {
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'blank',
      description: 'x',
      successCriteria: '   ',
      verificationHint: '\n',
    });
    assert.equal(store.getNode(nodeId)!.success_criteria, null);
    assert.equal(store.getNode(nodeId)!.verification_hint, null);
  });
});
