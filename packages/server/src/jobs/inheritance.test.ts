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
 * D16 -- session forking, which is what the M3 checkpoint turns on.
 *
 * Uses a recording runner rather than the SDK: what has to be right is WHICH
 * session each run inherits and whether it forks, and that is decided entirely
 * by the pipeline. Asserting it here costs nothing and needs no credentials.
 */
class RecordingRunner implements AgentRunner {
  readonly specs: RunSpec[] = [];
  constructor(private readonly writes = true) {}

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
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
    createProject(store, { name: 'p', description: 'd', model: null, permissionMode: 'acceptEdits' });

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

  test("a child's first run FORKS its parent's session", async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    const { nodeId } = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'a', description: 'd',
    });
    await run(nodeId, 'do the thing');

    const spec = runner.specs[1]!;
    assert.equal(spec.resumeSessionId, 'session-1', "must resume the PARENT's session");
    assert.equal(spec.forkSession, true);
    // The parent is untouched, and the child now owns a session of its own.
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
    assert.equal(store.getNode(nodeId)!.session_id, 'session-2');
  });

  test('siblings fork the same parent and cannot see each other (D1)', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    const a = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'a', description: 'd',
    });
    const b = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'b', description: 'd',
    });
    await run(a.nodeId, 'approach a');
    await run(b.nodeId, 'approach b');

    assert.equal(runner.specs[1]!.resumeSessionId, 'session-1');
    assert.equal(runner.specs[2]!.resumeSessionId, 'session-1');
    assert.notEqual(store.getNode(a.nodeId)!.session_id, store.getNode(b.nodeId)!.session_id);
  });

  /**
   * THE M3 CHECKPOINT, at the level this layer owns: a child of a
   * conversation-only node inherits that node's session even though its git
   * base skips straight past it.
   */
  test('CHECKPOINT: context lineage follows the parent, git lineage skips it', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    const masterCommit = store.getNode(masterNodeId)!.head_commit;

    const a = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'argparse', description: 'd',
    });
    await run(a.nodeId, 'build it');
    const aCommit = store.getNode(a.nodeId)!.head_commit;
    assert.notEqual(aCommit, masterCommit);

    // A question: runs, writes nothing, so it never gets a commit.
    const e = await createChildNode(store, {
      projectId, parentId: a.nodeId, displayName: 'why', description: 'd',
    });
    jobs.start(e.nodeId, '? explain');
    await settle(jobs, e.nodeId);
    // Read the id back rather than predicting a counter: what matters is that
    // the question owns a session and that its child inherits THAT one.
    const questionSession = store.getNode(e.nodeId)!.session_id;
    assert.notEqual(questionSession, null);
    assert.equal(
      store.getNode(e.nodeId)!.head_commit,
      null,
      'precondition: the question must have written nothing, so it has no commit',
    );

    const f = await createChildNode(store, {
      projectId, parentId: e.nodeId, displayName: 'child of the question', description: 'd',
    });
    await run(f.nodeId, 'act on it');

    // CONTEXT: forked from the question's session, not its grandparent's.
    const spec = runner.specs.at(-1)!;
    assert.equal(spec.resumeSessionId, questionSession, "must inherit the question's conversation");
    assert.equal(spec.forkSession, true);

    // CODE: pinned to argparse's commit, skipping the question entirely.
    assert.equal(store.getNode(f.nodeId)!.base_commit, aCommit);

    // A3: and we recorded how much of the parent's conversation it took.
    assert.notEqual(store.getNode(f.nodeId)!.forked_from_message_seq, null);
  });

  test('a frozen node still runs, but read-only (D4 + D18)', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    const a = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'a', description: 'd',
    });
    await run(a.nodeId, 'commit something');
    assert.notEqual(store.getNode(a.nodeId)!.head_commit, null, 'setup: the child must commit');

    // master is frozen now. It must still be able to answer a question.
    await run(masterNodeId, 'what did we decide?');
    const spec = runner.specs.at(-1)!;
    assert.equal(spec.readOnly, true, 'frozen means read-only, not refused');
    assert.equal(store.getNode(masterNodeId)!.status, 'ready');
  });

  test('a read-only run cannot create a commit', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    const before = store.getNode(masterNodeId)!.head_commit;
    const a = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'a', description: 'd',
    });
    await run(a.nodeId, 'commit something');

    await run(masterNodeId, 'just asking');
    assert.equal(store.getNode(masterNodeId)!.head_commit, before, 'frozen node must not advance');
  });
});
