import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createProject } from '../projects.js';
import { EXPERIMENT_FILES, writeExperimentSnapshot } from './experimentSnapshot.js';

test('a run still in progress is left out of a snapshot, so the copy reads as behind once it ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-snapshot-'));
  const db = openInMemory();
  try {
    const store = new Store(db, join(root, 'repos'));
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const done = { status: 'done', reason: 'finished', error: null } as const;
    const nothing = { cost: 0, inputTokens: 0, outputTokens: 0 };
    store.createRun('finished', masterNodeId);
    store.appendMessage({
      nodeId: masterNodeId,
      runId: 'finished',
      role: 'assistant',
      kind: 'text',
      content: 'the finished answer',
    });
    store.finishRun('finished', done, nothing);
    store.createRun('going', masterNodeId);
    store.appendMessage({
      nodeId: masterNodeId,
      runId: 'going',
      role: 'assistant',
      kind: 'text',
      content: 'half way through',
    });

    const folder = await mkdtemp(join(root, 'copy-'));
    const snapshot = await writeExperimentSnapshot(store, store.getNode(masterNodeId)!, folder);
    const conversation = await readFile(join(folder, EXPERIMENT_FILES.conversation), 'utf8');
    assert.equal(snapshot.runs, 1);
    assert.match(conversation, /the finished answer/);
    assert.doesNotMatch(conversation, /half way through/);
    assert.match(conversation, /still in progress/);

    const runCount = (): number =>
      store.treeView(projectId).find((n) => n.id === masterNodeId)!.runCount;
    assert.equal(runCount(), 1, 'the run in progress is not counted yet');
    store.finishRun('going', done, nothing);
    assert.equal(runCount() - snapshot.runs, 1, 'and once it ends, the copy is one run behind');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
