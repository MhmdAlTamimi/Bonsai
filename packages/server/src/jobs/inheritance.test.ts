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
import type { AgentRunner, ConversationCopier, RunEvent, RunSpec } from '../agent/AgentRunner.js';
import { copyParentConversation } from './conversation.js';
import { silentLogger } from '../log.js';

/**
 * How a node gets its conversation.
 *
 * Once, at creation: a child's session is a COPY of its parent's, cut at the
 * end of the parent's last finished run. After that the child resumes its own
 * session and nothing from the parent flows in. Asserted with a recording
 * runner because every one of these decisions is the pipeline's, not the SDK's.
 */
class RecordingRunner implements AgentRunner, ConversationCopier {
  readonly specs: RunSpec[] = [];
  readonly copies: Array<{ sessionId: string; upToMessageId: string | null }> = [];
  onRun: ((spec: RunSpec) => void) | null = null;
  failCopy = false;
  constructor(private readonly writes = true) {}

  forkConversation(sessionId: string, upToMessageId: string | null): Promise<string> {
    if (this.failCopy) return Promise.reject(new Error('session file missing'));
    this.copies.push({ sessionId, upToMessageId });
    return Promise.resolve(`copy-${this.copies.length}-of-${sessionId}`);
  }

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
    this.onRun?.(spec);
    yield { type: 'session', sessionId: spec.resumeSessionId ?? `session-${this.specs.length}` };
    yield { type: 'text', text: `handled: ${spec.prompt}` };
    yield { type: 'position', messageId: `end-of-run-${this.specs.length}` };
    if (spec.prompt === 'fail') {
      yield { type: 'error', error: 'the agent failed' };
      return;
    }
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

describe('conversation inheritance', () => {
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

  const child = async (projectId: string, parentId: string, name = 'child'): Promise<string> =>
    (await createChildNode(store, { projectId, parentId, displayName: name, description: '' }))
      .nodeId;

  test("master's first run starts a fresh session", async () => {
    const { masterNodeId } = await project();
    await run(masterNodeId, 'scaffold');
    assert.equal(runner.specs[0]!.resumeSessionId, null);
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
  });

  test('chatting with the same node resumes its own session', async () => {
    const { masterNodeId } = await project();
    await run(masterNodeId, 'first');
    await run(masterNodeId, 'second');
    assert.equal(runner.specs[1]!.resumeSessionId, 'session-1');
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
  });

  test("a child copies its parent's conversation at creation, cut at its last finished run", async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, '? explain the parser');
    const nodeId = await child(projectId, masterNodeId);

    assert.equal(await copyParentConversation(store, runner, nodeId, silentLogger), 'copied');
    assert.deepEqual(runner.copies, [{ sessionId: 'session-1', upToMessageId: 'end-of-run-1' }]);
    assert.equal(store.getNode(nodeId)!.session_id, 'copy-1-of-session-1');
    assert.equal(store.lineageOf(store.getNode(nodeId)!).conversationFrom?.id, masterNodeId);

    // Its first run continues the copy -- its own session -- not the parent's.
    await run(nodeId, '? carry on');
    assert.equal(runner.specs.at(-1)!.resumeSessionId, 'copy-1-of-session-1');
    assert.equal(store.getNode(masterNodeId)!.session_id, 'session-1');
  });

  test('the copy is fixed at creation: later parent turns never reach the child', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, '? first');
    const nodeId = await child(projectId, masterNodeId);
    await copyParentConversation(store, runner, nodeId, silentLogger);
    await run(masterNodeId, '? the parent keeps talking');
    await run(nodeId, '? child turn');
    await run(nodeId, '? another child turn');
    assert.equal(runner.copies.length, 1);
    assert.equal(runner.specs.at(-1)!.resumeSessionId, 'copy-1-of-session-1');
  });

  test('a run that did not finish does not move where the next copy is cut', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, '? finished');
    await run(masterNodeId, 'fail');
    assert.equal(store.listRuns(masterNodeId).at(-1)!.status, 'failed');
    const nodeId = await child(projectId, masterNodeId);
    await copyParentConversation(store, runner, nodeId, silentLogger);
    assert.equal(runner.copies[0]!.upToMessageId, 'end-of-run-1');
  });

  test('starting fresh copies nothing, and code is still inherited', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'code');
    const nodeId = await child(projectId, masterNodeId);
    // Fresh is simply not copying: the route skips copyParentConversation.
    await run(nodeId, '? hello');
    assert.equal(runner.copies.length, 0);
    assert.equal(runner.specs.at(-1)!.resumeSessionId, null);
    const lineage = store.lineageOf(store.getNode(nodeId)!);
    assert.equal(lineage.conversationFrom, null);
    assert.equal(lineage.codeFrom?.id, masterNodeId);
    assert.equal(lineage.diverged, false);
    assert.equal(store.getNode(nodeId)!.base_commit, store.getNode(masterNodeId)!.head_commit);
  });

  test('a parent that has not talked yet has nothing to copy', async () => {
    const { projectId, masterNodeId } = await project();
    const nodeId = await child(projectId, masterNodeId);
    assert.equal(
      await copyParentConversation(store, runner, nodeId, silentLogger),
      'nothing to copy',
    );
    assert.equal(store.childLineageOf(store.getNode(masterNodeId)!).conversationFrom, null);
  });

  test('a failed copy keeps the child and tells it why it starts without the conversation', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, '? first');
    const nodeId = await child(projectId, masterNodeId);
    runner.failCopy = true;
    assert.equal(await copyParentConversation(store, runner, nodeId, silentLogger), 'failed');
    assert.equal(store.getNode(nodeId)!.session_id, null);
    const note = store.listMessages(nodeId, 0).at(-1)!;
    assert.equal(note.role, 'system');
    assert.match(String(note.content), /session file missing/);
    assert.match(String(note.content), /starts without it/);
  });

  test('creation is metadata-only, first run allocates the pinned code, and parent remains writable', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'base');
    const nodeId = await child(projectId, masterNodeId, 'later');
    const node = store.getNode(nodeId)!;
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

  test('edited goals after execution begins cannot change its resolved context', async () => {
    const { projectId, masterNodeId } = await project();
    const created = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'fixed',
      description: '',
      successCriteria: 'original goal',
    });
    runner.onRun = (spec) => {
      if (spec.nodeId === created.nodeId)
        store.updateNode(created.nodeId, { successCriteria: 'next goal' });
    };
    await run(created.nodeId, '? begin');
    assert.equal(
      store.listRuns(created.nodeId).at(-1)!.resolvedContext!.successCriteria,
      'original goal',
    );
    runner.onRun = null;
    await run(created.nodeId, '? next');
    assert.equal(
      store.listRuns(created.nodeId).at(-1)!.resolvedContext!.successCriteria,
      'next goal',
    );
  });

  test('a question parent supplies the conversation while code stays pinned to its ancestor', async () => {
    const { projectId, masterNodeId } = await project();
    await run(masterNodeId, 'code');
    const question = await child(projectId, masterNodeId, 'question');
    await copyParentConversation(store, runner, question, silentLogger);
    await run(question, '? why this code');
    const answer = await child(projectId, question, 'answer');
    await copyParentConversation(store, runner, answer, silentLogger);

    // The copy comes from the question's own session, cut at its finished run.
    assert.deepEqual(runner.copies.at(-1), {
      sessionId: store.getNode(question)!.session_id,
      upToMessageId: store.getNode(question)!.session_position,
    });
    const lineage = store.lineageOf(store.getNode(answer)!);
    assert.equal(lineage.conversationFrom?.id, question);
    assert.equal(lineage.codeFrom?.id, masterNodeId);
    assert.equal(lineage.diverged, true);
    await run(answer, '? use the answer');
    const context = store.listRuns(answer).at(-1)!.resolvedContext!;
    assert.equal(context.parentNodeId, question);
    assert.equal(context.codeCommit, store.getNode(masterNodeId)!.head_commit);
  });

  test('allocation failure retains the experiment and releases the execution slot', async () => {
    const { projectId, masterNodeId } = await project();
    const nodeId = await child(projectId, masterNodeId, 'blocked');
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
