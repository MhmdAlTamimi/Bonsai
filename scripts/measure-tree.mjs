/**
 * How the store's two hot reads scale, on synthetic in-memory data.
 *
 *   treeView       -- rebuilt on every refetch, so every event pays for it.
 *   findFolderOwner -- run on every folder inspection while adopting.
 *
 * Run `npm run build:server` first. Empty history, reads only, no git.
 */
import { openInMemory } from '../packages/server/dist/db/open.js';
import { Store } from '../packages/server/dist/db/store.js';
const result = [];
for (const count of [5, 100, 500]) {
  const db = openInMemory();
  const store = new Store(db, '/tmp/health-memory-only');
  const project = store.createProject({
    name: 'measure',
    description: '',
    model: null,
    permissionMode: 'default',
  });
  const root = store.createNode({
    projectId: project.id,
    parentId: null,
    rootCommit: 'root',
    displayName: 'Root',
    description: '',
  });
  for (let i = 1; i < count; i++)
    store.createNode({
      projectId: project.id,
      parentId: root.id,
      displayName: `Experiment ${i}`,
      description: '',
    });
  for (let i = 0; i < 5; i++) store.treeView(project.id);
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    store.treeView(project.id);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  result.push({
    nodes: count,
    medianMs: Number(samples[15].toFixed(2)),
    p95Ms: Number(samples[28].toFixed(2)),
  });
  db.close();
}
// findFolderOwner, across many projects: the folder picker calls it per
// inspection, and it used to list every project's nodes one project at a time.
const lookup = [];
for (const projects of [5, 50]) {
  const db = openInMemory();
  const store = new Store(db, '/tmp/health-memory-only');
  let probe = '';
  for (let p = 0; p < projects; p++) {
    const project = store.createProject({
      name: `p${p}`,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const root = store.createNode({
      projectId: project.id,
      parentId: null,
      rootCommit: 'root',
      displayName: 'Root',
      description: '',
    });
    for (let i = 0; i < 20; i++) {
      const node = store.createNode({
        projectId: project.id,
        parentId: root.id,
        displayName: `Experiment ${i}`,
        description: '',
      });
      if (p === projects - 1 && i === 19) probe = node.worktree_path;
    }
  }
  for (let i = 0; i < 5; i++) store.findFolderOwner(probe);
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    store.findFolderOwner(probe);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  lookup.push({
    projects,
    nodesPerProject: 21,
    medianMs: Number(samples[15].toFixed(2)),
    p95Ms: Number(samples[28].toFixed(2)),
  });
  db.close();
}

console.log(JSON.stringify({ treeView: result, findFolderOwner: lookup }, null, 2));
