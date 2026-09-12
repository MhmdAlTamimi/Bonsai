import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LineageError,
  type LineageNode,
  ancestors,
  divergesFromLiveWalk,
  liveNearestAncestorCommit,
  lookupFrom,
  resolveBaseCommit,
} from './lineage.js';

const node = (
  id: string,
  parentId: string | null,
  baseCommit: string | null,
  headCommit: string | null,
): LineageNode => ({ id, parentId, baseCommit, headCommit });

/**
 * The PRD §2 demo tree.
 *
 *   master  head=c1
 *     |- A   base=c1  head=c2      committed
 *     |    \- E  base=c2  head=null   ran, changed nothing -> no branch
 *     |         \- F  base=c2  head=c3   skips E in git, inherits E's session
 *     \- B   base=c1  head=c4
 */
function demoTree(): LineageNode[] {
  return [
    node('master', null, null, 'c1'),
    node('A', 'master', 'c1', 'c2'),
    node('E', 'A', 'c2', null),
    node('F', 'E', 'c2', 'c3'),
    node('B', 'master', 'c1', 'c4'),
  ];
}

describe('resolveBaseCommit (pinned, one hop)', () => {
  test('a child of a committed node branches from that commit', () => {
    const t = lookupFrom(demoTree());
    assert.equal(resolveBaseCommit(t('A')!), 'c2');
  });

  test("a child of a commitless node forwards that node's pin, skipping it", () => {
    const t = lookupFrom(demoTree());
    // This is the demo's step 5: F branches from A's commit, not from E.
    assert.equal(resolveBaseCommit(t('E')!), 'c2');
  });

  test('master is a valid parent because the root commit invariant holds', () => {
    const t = lookupFrom(demoTree());
    assert.equal(resolveBaseCommit(t('master')!), 'c1');
  });

  test('throws if a parent has neither a commit nor a pin', () => {
    const orphan = node('X', 'master', null, null);
    assert.throws(() => resolveBaseCommit(orphan), LineageError);
  });
});

describe('liveNearestAncestorCommit (recursive definition)', () => {
  test('agrees with the pin across the whole demo tree', () => {
    const tree = demoTree();
    const t = lookupFrom(tree);
    for (const n of tree) {
      if (n.parentId === null) continue;
      assert.equal(
        n.baseCommit,
        liveNearestAncestorCommit(n.parentId, t),
        `pin and live walk disagree for ${n.id}`,
      );
    }
  });

  test('passes through a node that has a branch but no commit of its own', () => {
    // The clause that is easiest to get subtly wrong. C ran, produced a branch
    // ref, and committed nothing -- headCommit is null, so the walk continues.
    const tree = [
      node('master', null, null, 'c1'),
      node('C', 'master', 'c1', null),
      node('D', 'C', 'c1', null),
    ];
    assert.equal(liveNearestAncestorCommit('D', lookupFrom(tree)), 'c1');
  });

  test('walks more than one hop through chained commitless nodes', () => {
    const tree = [
      node('master', null, null, 'c1'),
      node('A', 'master', 'c1', 'c2'),
      node('E1', 'A', 'c2', null),
      node('E2', 'E1', 'c2', null),
      node('E3', 'E2', 'c2', null),
      node('G', 'E3', 'c2', null),
    ];
    const t = lookupFrom(tree);
    assert.equal(liveNearestAncestorCommit('E3', t), 'c2');
    assert.equal(resolveBaseCommit(t('E3')!), 'c2');
  });

  test('throws rather than guessing if the root has no commit', () => {
    const tree = [node('master', null, null, null), node('A', 'master', null, null)];
    assert.throws(() => liveNearestAncestorCommit('A', lookupFrom(tree)), LineageError);
  });

  test('detects a cycle instead of looping forever', () => {
    const tree = [node('X', 'Y', null, null), node('Y', 'X', null, null)];
    assert.throws(() => liveNearestAncestorCommit('X', lookupFrom(tree)), /cycle/);
  });

  test('throws on a dangling parent reference', () => {
    const tree = [node('A', 'ghost', 'c1', null)];
    assert.throws(() => liveNearestAncestorCommit('A', lookupFrom(tree)), /missing parent/);
  });
});

describe('the pin diverging from a live walk is intended behaviour', () => {
  test('an ancestor committing later does not move an existing subtree', () => {
    // t1: E exists under A, pinned to A's commit c2.
    const tree = [
      node('master', null, null, 'c1'),
      node('A', 'master', 'c1', 'c2'),
      node('E', 'A', 'c2', null),
    ];

    // t2: A is still writable (its only child committed nothing), so the user
    // chats with it again and it commits c9.
    tree[1]!.headCommit = 'c9';

    const t = lookupFrom(tree);

    // A live walk would now drag E's subtree onto c9...
    assert.equal(liveNearestAncestorCommit('E', t), 'c9');
    // ...but the pin holds, so a new child of E still lands on c2, keeping its
    // inherited conversation and its code describing the same tree.
    assert.equal(resolveBaseCommit(t('E')!), 'c2');

    // And the divergence is reported rather than hidden.
    assert.equal(divergesFromLiveWalk(t('E')!, t), true);
  });

  test('a new child of the ancestor does get the newer commit', () => {
    const tree = [node('master', null, null, 'c1'), node('A', 'master', 'c1', 'c9')];
    const t = lookupFrom(tree);
    // Siblings on different bases, each coherent with its own conversation.
    assert.equal(resolveBaseCommit(t('A')!), 'c9');
  });

  test('no divergence is reported for an untouched tree', () => {
    const tree = demoTree();
    const t = lookupFrom(tree);
    for (const n of tree) {
      assert.equal(divergesFromLiveWalk(n, t), false, `${n.id} should not diverge`);
    }
  });
});

describe('ancestors', () => {
  test('lists ancestors nearest first and excludes the node itself', () => {
    const t = lookupFrom(demoTree());
    assert.deepEqual(
      ancestors('F', t).map((n) => n.id),
      ['E', 'A', 'master'],
    );
  });

  test('the root has none', () => {
    assert.deepEqual(ancestors('master', lookupFrom(demoTree())), []);
  });
});
