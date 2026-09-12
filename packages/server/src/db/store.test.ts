import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeView } from '@bonsai/shared';

import { openInMemory } from './open.js';
import { Store } from './store.js';
import { seedDemoProject } from './seed.js';

describe('store, against real SQL', () => {
  let db: DatabaseSync;
  let store: Store;
  let projectId: string;
  let byName: Map<string, NodeView>;

  beforeEach(() => {
    db = openInMemory();
    projectId = seedDemoProject(db, '/tmp/bonsai-test');
    store = new Store(db, '/tmp/bonsai-test');
    byName = new Map(store.treeView(projectId).map((n) => [n.displayName, n]));
  });

  test('the demo tree is five nodes with correct nesting', () => {
    const nodes = store.treeView(projectId);
    assert.equal(nodes.length, 5);
    const parentOf = (name: string): string | null => {
      const p = byName.get(name)!.parentId;
      return p === null ? null : store.getNode(p)!.display_name;
    };
    assert.equal(parentOf('master'), null);
    assert.equal(parentOf('argparse'), 'master');
    assert.equal(parentOf('click'), 'master');
    assert.equal(parentOf('why argparse?'), 'argparse');
    assert.equal(parentOf('add --verbose'), 'why argparse?');
  });

  test("the exploration's child branches from its grandparent's commit", () => {
    // Demo step 5, read straight out of the database.
    const f = store.getNode(byName.get('add --verbose')!.id)!;
    const a = store.getNode(byName.get('argparse')!.id)!;
    const e = store.getNode(byName.get('why argparse?')!.id)!;

    assert.equal(e.head_commit, null, 'the exploration must have no commit');
    assert.equal(e.branch_name, null, 'and therefore no branch');
    assert.equal(f.base_commit, a.head_commit);
    assert.equal(f.base_commit, 'c2bbbbb');
  });

  test('a node with a commitless child is still writable', () => {
    const a = byName.get('argparse')!;
    assert.equal(a.isLeaf, false);
    assert.equal(a.writable, true);
    assert.equal(a.createsBranch, true);
  });

  test('a node with a committed child is frozen', () => {
    assert.equal(byName.get('master')!.writable, false);
    assert.equal(byName.get('why argparse?')!.writable, false);
    // And says which of the two reasons it is, since a node can also be
    // unwritable for being the user's own folder.
    assert.equal(byName.get('master')!.frozenReason, 'child_committed');
    assert.equal(byName.get('argparse')!.frozenReason, null);
  });

  test('createsBranch is an outcome, not a creation-time choice', () => {
    assert.equal(byName.get('why argparse?')!.createsBranch, false);
    assert.equal(byName.get('click')!.createsBranch, true);
  });

  test('a new child pins its base to the parent tip at creation', () => {
    const a = store.getNode(byName.get('argparse')!.id)!;
    const child = store.createNode({
      projectId,
      parentId: a.id,
      displayName: 'later child',
      description: 'created after the exploration',
    });
    assert.equal(child.base_commit, 'c2bbbbb');

    // A is still writable (its children have no commits yet), so it commits
    // again. The existing subtree must not move.
    db.prepare(`UPDATE node SET head_commit = 'c9eeeee' WHERE id = ?`).run(a.id);
    const f = store.getNode(byName.get('add --verbose')!.id)!;
    assert.equal(f.base_commit, 'c2bbbbb', 'pinned base must not follow the ancestor');
    assert.equal(store.baseDiverges(f), true, 'and the divergence must be reported');
  });

  test('the schema refuses a non-root node without a pinned base', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO node (id, project_id, parent_id, display_name, description,
                               worktree_path, status, created_at)
             VALUES ('x', ?, (SELECT id FROM node WHERE display_name='master'),
                     'bad', '', '/tmp/x', 'new', '2026-01-01')`,
          )
          .run(projectId),
      /CHECK constraint failed/,
    );
  });

  test('the schema refuses a commit without a branch', () => {
    assert.throws(
      () =>
        db
          .prepare(`UPDATE node SET head_commit = 'deadbee' WHERE display_name = 'why argparse?'`)
          .run(),
      /CHECK constraint failed/,
    );
  });

  test('delete cascades to descendants', () => {
    store.deleteNode(byName.get('argparse')!.id);
    const names = store
      .treeView(projectId)
      .map((n) => n.displayName)
      .sort();
    assert.deepEqual(names, ['click', 'master']);
  });

  test('renaming never touches the branch', () => {
    const before = store.getNode(byName.get('click')!.id)!;
    store.updateNode(before.id, { displayName: 'click-based' });
    const after = store.getNode(before.id)!;
    assert.equal(after.display_name, 'click-based');
    assert.equal(after.branch_name, before.branch_name);
  });
});
