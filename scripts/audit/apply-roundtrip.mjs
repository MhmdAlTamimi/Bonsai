/**
 * Audit phase 12: Apply, end to end, with every kind of change.
 *
 *   npm run build:server && node scripts/audit/apply-roundtrip.mjs
 *
 * A project made from a folder of yours. Its experiment edits a file,
 * replaces an image, renames one file, deletes another, makes a script
 * non-executable, and adds a file with spaces and accents in its name and an
 * empty one. Then:
 *
 *   1. the command Apply shows is run as written, in a shell: does your folder
 *      end up with exactly the experiment's files?
 *   2. your folder has changed the same lines meanwhile: what happens?
 *   3. you have uncommitted edits in a file the experiment changed: what happens?
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-apply-'));
const yours = join(root, 'my-app');
await mkdir(join(yours, 'src'), { recursive: true });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv }).toString().trim();
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * seed + 7) % 256));
git(yours, 'init', '-q', '--initial-branch=main');
await writeFile(
  join(yours, 'src/app.js'),
  'export const greeting = "hello";\nexport const answer = 41;\n',
);
await writeFile(join(yours, 'run.sh'), '#!/bin/sh\necho run\n');
await chmod(join(yours, 'run.sh'), 0o755);
await writeFile(join(yours, 'logo.png'), bytes(2048, 31));
await writeFile(join(yours, 'old-name.txt'), 'a file that will be renamed\n'.repeat(5));
await writeFile(join(yours, 'to-delete.txt'), 'a file that will be deleted\n');
git(yours, 'add', '-A');
git(yours, 'commit', '-qm', 'first');

const bonsai = await startBonsai(join(root, 'data'));
try {
  const project = (
    await bonsai.api('POST', '/api/projects/adopt', { path: yours, description: '' })
  ).body;
  const id = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'Everything changes',
      description: '',
    })
  ).body.node.id;
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'first' });
  await bonsai.settle(id);
  const db = new DatabaseSync(join(root, 'data', 'bonsai.db'), { readOnly: true });
  const folder = db.prepare('SELECT worktree_path FROM node WHERE id = ?').get(id).worktree_path;
  db.close();

  // The experiment's changes, made in its folder; the next run commits them.
  await writeFile(
    join(folder, 'src/app.js'),
    'export const greeting = "hello";\nexport const answer = 42;\n',
  );
  await writeFile(join(folder, 'logo.png'), bytes(2048, 57));
  await rename(join(folder, 'old-name.txt'), join(folder, 'new-name.txt'));
  await rm(join(folder, 'to-delete.txt'));
  await chmod(join(folder, 'run.sh'), 0o644);
  await mkdir(join(folder, 'docs'), { recursive: true });
  await writeFile(join(folder, 'docs/Ünïcode notes – draft.md'), '# Notes\n');
  await writeFile(join(folder, 'docs/empty.txt'), '');
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'save' });
  await bonsai.settle(id);

  const apply = (await bonsai.api('POST', `/api/nodes/${id}/patch`, { scope: 'line' })).body;
  console.log(`Apply shows: ${apply.command}`);
  const run = (command) => spawnSync(command, { shell: true, cwd: root, encoding: 'utf8' });

  // 1. As written.
  const first = run(apply.command);
  console.log(
    `1. run as written: exit ${first.status} ${(first.stderr || '').trim().split('\n')[0] ?? ''}`,
  );
  git(yours, 'add', '-A');
  const want = git(folder, 'rev-parse', 'HEAD^{tree}');
  const flat = (cwd, tree) =>
    git(cwd, 'ls-tree', '-r', tree)
      .split('\n')
      .filter((line) => !/\t\.bonsai\/notes-[0-9a-f-]+\.md$/.test(line));
  const got = git(yours, 'write-tree');
  const missing = flat(folder, want).filter((line) => !flat(yours, got).includes(line));
  const extra = flat(yours, got).filter((line) => !flat(folder, want).includes(line));
  console.log(
    `   your folder now matches the experiment exactly: ${missing.length === 0 && extra.length === 0}` +
      (missing.length + extra.length > 0
        ? `\n   missing: ${missing.join(' | ')}\n   extra: ${extra.join(' | ')}`
        : ''),
  );
  git(yours, 'reset', '-q', '--hard', 'HEAD');
  git(yours, 'clean', '-qfd');

  // 2. Your folder changed the same line meanwhile.
  await writeFile(
    join(yours, 'src/app.js'),
    'export const greeting = "hello";\nexport const answer = 40;\n',
  );
  git(yours, 'commit', '-qam', 'my own change to the same line');
  const second = run(apply.command);
  console.log(
    `2. same line changed in your folder: exit ${second.status}\n   ${(second.stderr || second.stdout).trim().split('\n').join('\n   ')}`,
  );
  console.log(
    `   your folder's status:\n   ${git(yours, 'status', '--short').split('\n').join('\n   ')}`,
  );
  git(yours, 'reset', '-q', '--hard', 'HEAD~1');
  git(yours, 'clean', '-qfd');

  // 3. Uncommitted edits of yours in a file the experiment changed.
  await writeFile(
    join(yours, 'src/app.js'),
    'export const greeting = "hi";\nexport const answer = 41;\n',
  );
  const third = run(apply.command);
  console.log(
    `3. your uncommitted edit in a changed file: exit ${third.status}\n   ${(third.stderr || third.stdout).trim().split('\n').join('\n   ')}`,
  );
  console.log(`   anything applied? ${git(yours, 'status', '--short').split('\n').join(', ')}`);
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
