/**
 * Audit phase 5: deleting an experiment when one folder in it cannot be
 * removed.
 *
 *   npm run build:server && node scripts/audit/partial-delete.mjs
 *
 * On Windows a folder cannot be removed while a file in it is open — an
 * editor, a virus scanner, a dev server the agent started. Here the same
 * failure is made with `git worktree lock` on one of three child experiments,
 * then their parent is deleted. Prints what the delete reported, what is left
 * on disk, in git and on the map, and whether a second delete finishes the job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-partial-'));
const dataDir = join(root, 'data');
const bonsai = await startBonsai(dataDir);

function snapshot(repo, projectId, nodes) {
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const refs = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname)', `refs/bonsai/${projectId}/`],
    {
      cwd: repo,
    },
  ).toString();
  const rows = nodes.map((node) => ({
    name: node.name,
    onTheMap: db.prepare('SELECT 1 FROM node WHERE id = ?').get(node.id) !== undefined,
    folder: existsSync(node.folder),
    ref: refs.includes(node.id),
  }));
  db.close();
  return rows;
}

try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'partial', description: '' }))
    .body;
  const make = async (parentId, name) => {
    const node = (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId,
        displayName: name,
        description: '',
      })
    ).body.node;
    await bonsai.api('POST', `/api/nodes/${node.id}/runs`, { prompt: name });
    await bonsai.settle(node.id);
    return node.id;
  };
  const parent = await make(project.masterNodeId, 'parent');
  const children = [
    await make(parent, 'child 1'),
    await make(parent, 'child 2'),
    await make(parent, 'child 3'),
  ];

  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const repo = db
    .prepare('SELECT repo_path FROM project WHERE id = ?')
    .get(project.projectId).repo_path;
  const folder = (id) =>
    db.prepare('SELECT worktree_path FROM node WHERE id = ?').get(id).worktree_path;
  const nodes = [
    { id: parent, name: 'parent', folder: folder(parent) },
    ...children.map((id, i) => ({ id, name: `child ${i + 1}`, folder: folder(id) })),
  ];
  db.close();

  // The folder that cannot go.
  execFileSync(
    'git',
    ['worktree', 'lock', '--reason', 'open in another program', nodes[2].folder],
    { cwd: repo },
  );

  const first = await bonsai.api('DELETE', `/api/nodes/${parent}`);
  console.log(`delete "parent": HTTP ${first.status} ${JSON.stringify(first.body).slice(0, 400)}`);
  console.table(snapshot(repo, project.projectId, nodes));
  for (const node of nodes.slice(0, 2)) {
    const opened = await bonsai.api('GET', `/api/nodes/${node.id}`);
    console.log(
      `open "${node.name}" now: HTTP ${opened.status} ${opened.status >= 400 ? JSON.stringify(opened.body).slice(0, 160) : ''}`,
    );
  }
  await bonsai.api('POST', `/api/nodes/${nodes[1].id}/runs`, { prompt: 'carry on' });
  const run = (await bonsai.settle(nodes[1].id)).body;
  console.log(
    `run "child 1" again: ${run?.node?.status ?? JSON.stringify(run).slice(0, 160)} ${(run?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 140)}`,
  );

  execFileSync('git', ['worktree', 'unlock', nodes[2].folder], { cwd: repo });
  const second = await bonsai.api('DELETE', `/api/nodes/${parent}`);
  console.log(`delete again once the folder is free: HTTP ${second.status}`);
  console.table(snapshot(repo, project.projectId, nodes));
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
