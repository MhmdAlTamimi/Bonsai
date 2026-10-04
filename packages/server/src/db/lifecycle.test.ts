import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './open.js';
import { Store } from './store.js';

test('accepted requests and attachments survive reopening, and finalization rolls back as a unit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-durable-run-'));
  let db = openDatabase(dir);
  try {
    let store = new Store(db, join(dir, 'repos'));
    const project = store.createProject({
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const node = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'main',
      description: '',
      rootCommit: 'before',
      initialExperimentIds: ['saved-for-later-source'],
    });
    const request = {
      prompt: 'the queued request',
      command: false,
      referenceIds: ['reference-id'],
      experimentIds: ['experiment-id'],
    };
    store.enqueueRun('queued-run', node.id, request);
    store.askQuestion({
      id: 'old-question',
      nodeId: node.id,
      runId: 'queued-run',
      text: 'Continue?',
    });
    assert.equal(store.pendingQuestion(node.id)?.id, 'old-question');
    db.close();
    db = openDatabase(dir);
    store = new Store(db, join(dir, 'repos'));
    assert.deepEqual(JSON.parse(store.getNode(node.id)!.initial_experiment_ids!), [
      'saved-for-later-source',
    ]);
    assert.deepEqual(store.runs.requestOf('queued-run'), request);
    assert.equal(store.lastUserPrompt(node.id), request.prompt);
    assert.equal(store.markOrphanedRunsInterrupted(), 1);
    assert.equal(store.getNode(node.id)!.status, 'interrupted');
    assert.equal(
      store.pendingQuestion(node.id),
      null,
      'ended runs cannot leave live answer controls',
    );
    assert.deepEqual(store.runs.requestOf('queued-run'), request);

    // Fail after the commit/head and run-end writes, before the status write.
    db.exec(
      "CREATE TRIGGER fail_status BEFORE UPDATE OF status ON node WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'disk write fixture'); END",
    );
    const complete = () =>
      store.completeRun(
        'queued-run',
        node.id,
        { status: 'done', reason: 'finished', error: null },
        { cost: 0.5, inputTokens: 10, outputTokens: 5, commitSha: 'after' },
        {
          status: 'ready',
          commit: { branch: 'master', head: 'after' },
          sessionPosition: 'message-id',
        },
      );
    assert.throws(complete, /disk write fixture/);
    assert.equal(store.getNode(node.id)!.head_commit, 'before');
    assert.equal(store.getNode(node.id)!.session_position, null);
    assert.equal(store.getRun('queued-run')!.status, 'failed');
    assert.equal(store.listRuns(node.id)[0]!.costUsd, 0);
    db.exec('DROP TRIGGER fail_status');
    complete();
    assert.equal(store.getNode(node.id)!.head_commit, 'after');
    assert.equal(store.getNode(node.id)!.status, 'ready');
    assert.equal(store.getNode(node.id)!.session_position, 'message-id');
    assert.equal(store.getRun('queued-run')!.commit_sha, 'after');
    assert.equal(store.listRuns(node.id)[0]!.costUsd, 0.5);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
