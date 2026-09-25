import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from './open.js';
import { Store } from './store.js';
import { createChildNode, createProject } from '../projects.js';

/**
 * How many queries building a tree costs.
 *
 * Asserted as a NUMBER rather than a shape, because the failure this guards
 * against is invisible in behaviour: a per-node query inside the tree loop is
 * correct, fast at five nodes, and quietly a storm at a hundred with several
 * agents running -- the tree is rebuilt after every status change of every
 * sibling. Nothing but a count catches it before someone with a large project
 * does.
 */
describe('building a tree', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-tree-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test('creation preview and existing lineage name the pinned source after ancestors advance', async () => {
    const created = await createProject(store, {
      name: 'lineage',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const code = store.createNode({
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'Code',
      description: '',
    });
    store.recordCommit(code.id, `node/${code.id}`, 'code-snapshot-1');
    store.createRun('source-run', code.id);
    db.prepare('UPDATE run SET commit_sha = ? WHERE id = ?').run('code-snapshot-1', 'source-run');
    const question = store.createNode({
      projectId: created.projectId,
      parentId: code.id,
      displayName: 'Discussion',
      description: '',
    });
    // The discussion has talked, and the leaf took a copy of that conversation.
    store.setSessionId(question.id, 'discussion-session');
    const leaf = store.createNode({
      projectId: created.projectId,
      parentId: question.id,
      displayName: 'Next',
      description: '',
    });
    store.adoptForkedSession(leaf.id, 'copy-of-discussion', 2);
    const preview = store.childLineageOf(store.getNode(question.id)!);
    const version = store.childSourceVersion(question);
    assert.equal(preview.conversationFrom?.id, question.id);
    assert.equal(preview.codeFrom?.id, code.id);
    store.recordCommit(code.id, `node/${code.id}`, 'code-snapshot-2');
    store.recordCommit(question.id, `node/${question.id}`, 'discussion-snapshot-1');
    assert.deepEqual(
      store.lineageOf(store.getNode(leaf.id)!),
      preview,
      'later commits do not relabel the inherited code',
    );
    assert.notEqual(store.childSourceVersion(store.getNode(question.id)!), version);
    assert.equal(
      store.childLineageOf(store.getNode(question.id)!).codeFrom?.id,
      question.id,
      'a future child uses the new snapshot',
    );
  });

  /** Counts prepare() calls, which is one per query issued. */
  function countQueries<T>(work: () => T): { result: T; queries: number } {
    const original = db.prepare.bind(db);
    let queries = 0;
    (db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => {
      queries += 1;
      return original(sql);
    };
    try {
      return { result: work(), queries };
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = original;
    }
  }

  async function projectWith(children: number): Promise<string> {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    for (let i = 0; i < children; i += 1) {
      await createChildNode(store, {
        projectId: created.projectId,
        parentId: created.masterNodeId,
        displayName: `n${i}`,
        description: '',
      });
    }
    return created.projectId;
  }

  test('costs a constant number of queries, whatever the size', async () => {
    const small = await projectWith(2);
    const large = await projectWith(25);

    const a = countQueries(() => store.treeView(small));
    const b = countQueries(() => store.treeView(large));

    assert.equal(a.result.length, 3);
    assert.equal(b.result.length, 26);
    assert.equal(
      a.queries,
      b.queries,
      `a 26-node tree issued ${b.queries} queries and a 3-node tree ${a.queries} — ` +
        'something in the loop is querying per node',
    );
    // A generous ceiling: the point is that it does not grow, but a number
    // this low also says nobody has quietly added a second per-tree query
    // that could have been folded into an existing one.
    assert.ok(b.queries <= 8, `${b.queries} queries for one tree is more than expected`);
  });

  test('still reports the right costs after being made one query', async () => {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'spender',
      description: '',
    });

    for (const cost of [0.25, 0.5]) {
      const runId = `run-${cost}`;
      store.createRun(runId, nodeId);
      store.finishRun(
        runId,
        { status: 'done', reason: 'finished', error: null },
        { cost, inputTokens: 0, outputTokens: 0 },
      );
    }

    const view = store.treeView(created.projectId).find((n) => n.id === nodeId)!;
    // Summed across the node's runs, and agreeing with the single-node query
    // the panel still uses.
    assert.equal(view.costUsd, 0.75);
    assert.equal(store.nodeCost(nodeId), 0.75);
    assert.equal(store.projectCost(created.projectId), 0.75);
    // A node with no runs is zero, not absent.
    const master = store.treeView(created.projectId).find((n) => n.parentId === null)!;
    assert.equal(master.costUsd, 0);
  });
});
