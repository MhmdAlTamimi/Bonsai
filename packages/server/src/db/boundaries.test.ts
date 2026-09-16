import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openInMemory } from './open.js';
import { Store } from './store.js';

/**
 * The store's boundaries, asserted rather than described.
 *
 * `store.ts` was one class over five tables and it grew with every feature,
 * because there was no line for a change to be on the wrong side of. The split
 * only helps for as long as the line holds, and a comment does not hold it — so
 * the rule is a test: a concern-sized store may depend on the row shapes and on
 * nothing else in this directory.
 *
 * `views.ts` is the deliberate exception and is named as one. It exists to read
 * across the concerns, which is why the facade hands it the others.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/db/boundaries.test.js -> packages/server
const srcDir = resolve(here, '..', '..', 'src', 'db');

const CONCERNS = ['projectStore', 'nodeStore', 'runStore', 'messageStore', 'checkStore'] as const;

function localImports(file: string): string[] {
  const text = readFileSync(join(srcDir, `${file}.ts`), 'utf8');
  return [...text.matchAll(/from '\.\/([A-Za-z]+)\.js'/g)].map((m) => m[1]!);
}

describe('the store splits by concern', () => {
  test('no concern-sized store reaches into another one', () => {
    for (const concern of CONCERNS) {
      const offending = localImports(concern).filter((dep) => dep !== 'rows');
      assert.deepEqual(
        offending,
        [],
        `${concern}.ts imports ${offending.join(', ')}; only rows.ts is shared. ` +
          'Anything that spans concerns belongs in the Store facade or in views.ts.',
      );
    }
  });

  test('rows.ts stays free of the database', () => {
    const text = readFileSync(join(srcDir, 'rows.ts'), 'utf8');
    assert.ok(!text.includes('DatabaseSync'), 'rows.ts must hold shapes and pure functions only');
  });

  test('the facade and the sub-stores answer the same questions', () => {
    const db = openInMemory();
    const store = new Store(db, '/tmp/bonsai-boundaries');
    const project = store.createProject({
      name: 'boundaries',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const root = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'master',
      description: '',
      rootCommit: 'root',
    });
    const child = store.createNode({
      projectId: project.id,
      parentId: root.id,
      displayName: 'child',
      description: 'try something',
      successCriteria: 'the tests pass',
    });

    assert.equal(store.getProject(project.id)?.id, store.projects.get(project.id)?.id);
    assert.equal(store.getNode(child.id)?.id, store.nodes.get(child.id)?.id);
    assert.equal(store.treeView(project.id).length, store.views.tree(project.id).length);
    assert.equal(store.checks.of(child.id).successCriteria, 'the tests pass');
    assert.equal(store.checks.of(child.id).verificationHint, null);

    db.close();
  });
});
