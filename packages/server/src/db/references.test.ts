import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from './open.js';
import { Store } from './store.js';
import { createChildNode, createProject } from '../projects.js';
import { OperationConflict } from '../domain/errors.js';
import { revisionOf } from './referenceStore.js';

describe('references', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let projectId: string;
  let masterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-refs-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
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
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const add = (name: string, content = 'x', sourceNodeId: string | null = null) =>
    store.references.create({ projectId, name, content, sourceNodeId });

  test('are listed by name, and a view carries size, revision and source', () => {
    add('smoke-test', 'run npm test', masterId);
    add('api-contract');
    const views = store.references.list(projectId).map((row) => store.referenceView(row));
    assert.deepEqual(
      views.map((v) => v.name),
      ['api-contract', 'smoke-test'],
    );
    const smoke = views[1]!;
    assert.equal(smoke.size, 'run npm test'.length);
    assert.equal(smoke.revision, revisionOf('run npm test'));
    assert.equal(smoke.source?.id, masterId);
  });

  test('a name means one thing in a project, whatever its case', () => {
    add('Smoke-Test');
    assert.throws(() => add('smoke-test'), OperationConflict);
    const other = add('other');
    assert.throws(
      () => store.references.update(other.id, { name: 'SMOKE-TEST' }),
      OperationConflict,
    );
  });

  test('editing changes the revision, so earlier runs can tell', () => {
    const row = add('smoke-test', 'first');
    store.references.update(row.id, { content: 'second' });
    const view = store.referenceView(store.references.get(row.id)!);
    assert.equal(view.content, 'second');
    assert.notEqual(view.revision, revisionOf('first'));
  });

  test('an edit keeps its source unless it names a new one', async () => {
    const child = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'try-redis',
      description: '',
    });
    const row = add('smoke-test', 'first', masterId);
    store.references.update(row.id, { content: 'second' });
    assert.equal(store.references.get(row.id)?.source_node_id, masterId);
    store.references.update(row.id, { content: 'third', sourceNodeId: child.nodeId });
    assert.equal(
      store.referenceView(store.references.get(row.id)!).source?.displayName,
      'try-redis',
    );
  });

  test('outlives the experiment it was drawn from', async () => {
    const child = await createChildNode(store, {
      projectId,
      parentId: masterId,
      displayName: 'try-redis',
      description: '',
    });
    const row = add('redis-result', 'p95 40ms', child.nodeId);
    store.deleteNode(child.nodeId);
    const view = store.referenceView(store.references.get(row.id)!);
    assert.equal(view.content, 'p95 40ms');
    assert.equal(view.source, null);
  });

  test('go with their project', () => {
    add('smoke-test');
    store.deleteProject(projectId);
    assert.equal(store.references.list(projectId).length, 0);
  });
});
