/**
 * Audit phase 5: random sequences of create, run, archive, restore and
 * delete, checked against a model after every step — property-based testing
 * by hand.
 *
 *   npm run build:server && node scripts/audit/model.mjs [steps] [seed]
 *
 * The rules checked after every step:
 *   1. the map shows exactly the experiments the model has, with the same parents;
 *   2. every experiment's hidden ref is where the database says its code is;
 *   3. archiving and running again brings the same commit back, at the same path;
 *   4. deleting removes exactly what the confirmation listed, and nothing else;
 *   5. the only experiment folders on disk are those of live, unarchived experiments.
 *
 * A failure prints the seed and the steps so far; the same seed replays it.
 * A library such as fast-check adds the one thing this lacks: shrinking a
 * failing sequence to the shortest one that still fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startBonsai } from './lib.mjs';

const steps = Number(process.argv[2] ?? 150);
const seed = Number(process.argv[3] ?? Math.floor(Math.random() * 2 ** 31));
let state = seed;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const root = await mkdtemp(join(tmpdir(), 'bonsai-model-'));
const dataDir = join(root, 'data');
const bonsai = await startBonsai(dataDir, { BONSAI_FAKE_DELAY_MS: '20' });
const log = [];
const failures = [];
const fail = (rule, detail) => failures.push(`step ${log.length}: ${rule} — ${detail}`);

function database(projectId) {
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const project = db.prepare('SELECT repo_path FROM project WHERE id = ?').get(projectId);
  const rows = db
    .prepare(
      'SELECT id, parent_id, head_commit, base_commit, worktree_path, worktree_allocated, archived_at FROM node WHERE project_id = ?',
    )
    .all(projectId);
  db.close();
  return { repo: project.repo_path, rows };
}

function refs(repo, projectId) {
  const out = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname) %(objectname)', `refs/bonsai/${projectId}/`],
    { cwd: repo },
  ).toString();
  return new Map(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split(' ');
        return [ref.split('/').at(-1), sha];
      }),
  );
}

try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'model', description: '' }))
    .body;
  // The model: node id -> parent id. Master is the root and is never deleted.
  const model = new Map([[project.masterNodeId, null]]);
  const worktreesDir = join(dataDir, 'repos', project.projectId, 'worktrees');

  const check = async () => {
    const { repo, rows } = database(project.projectId);
    const tree = (await bonsai.api('GET', `/api/projects/${project.projectId}/tree`)).body;
    const onMap = new Map(tree.nodes.map((n) => [n.id, n.parentId]));
    for (const [id, parent] of model)
      if (onMap.get(id) !== parent) fail('1 map = model', `${id.slice(0, 8)} missing or moved`);
    for (const id of onMap.keys())
      if (!model.has(id)) fail('1 map = model', `${id.slice(0, 8)} should be gone`);
    const pinned = refs(repo, project.projectId);
    for (const row of rows) {
      const tip = row.head_commit ?? row.base_commit;
      if (tip !== null && pinned.get(row.id) !== tip)
        fail(
          '2 ref = database',
          `${row.id.slice(0, 8)} ref ${pinned.get(row.id)?.slice(0, 7)} vs ${tip.slice(0, 7)}`,
        );
    }
    for (const id of pinned.keys())
      if (!rows.some((row) => row.id === id))
        fail('2 ref = database', `ref left for deleted ${id.slice(0, 8)}`);
    const live = new Set(
      rows.filter((r) => r.worktree_allocated === 1 && r.archived_at === null).map((r) => r.id),
    );
    if (existsSync(worktreesDir))
      for (const name of readdirSync(worktreesDir))
        if (!live.has(name)) fail('5 folders', `folder left for ${name.slice(0, 8)}`);
    for (const row of rows)
      if (live.has(row.id) && !existsSync(row.worktree_path))
        fail('5 folders', `${row.id.slice(0, 8)} has lost its folder`);
  };

  for (let i = 0; i < steps; i++) {
    const ids = [...model.keys()];
    const children = ids.filter((id) => id !== project.masterNodeId);
    const roll = random();
    if (roll < 0.3 || children.length === 0) {
      const parentId = pick(ids);
      const made = await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId,
        displayName: `n${i}`,
        description: '',
      });
      log.push(`create under ${parentId.slice(0, 8)}: ${made.status}`);
      if (made.status === 201) model.set(made.body.node.id, parentId);
    } else if (roll < 0.6) {
      const id = pick(ids);
      await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `step ${i}` });
      const after = (await bonsai.settle(id)).body;
      log.push(`run ${id.slice(0, 8)}: ${after?.node?.status}`);
      if (after?.node?.status !== 'ready' && after?.node?.status !== 'new')
        fail(
          'run',
          `${id.slice(0, 8)} ended ${after?.node?.status}: ${after?.runs?.at(-1)?.error}`,
        );
    } else if (roll < 0.8) {
      const id = pick(children);
      const before = database(project.projectId).rows.find((r) => r.id === id);
      const archived = await bonsai.api('POST', `/api/nodes/${id}/archive`, {
        removeIgnored: true,
      });
      log.push(`archive ${id.slice(0, 8)}: ${archived.status}`);
      if (archived.status === 200) {
        await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `restore ${i}` });
        await bonsai.settle(id);
        const restored = database(project.projectId).rows.find((r) => r.id === id);
        if (restored.worktree_path !== before.worktree_path)
          fail('3 archive and back', 'came back at another path');
        if (!existsSync(restored.worktree_path))
          fail('3 archive and back', 'no folder after the run');
        log.push(`  restored by a run`);
      }
    } else {
      const id = pick(children);
      const impact = (await bonsai.api('GET', `/api/nodes/${id}/deletion-impact`)).body;
      const expected = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const [node, parent] of model)
          if (parent !== null && expected.has(parent) && !expected.has(node)) {
            expected.add(node);
            grew = true;
          }
      }
      if (impact.nodes !== expected.size)
        fail(
          '4 delete = confirmation',
          `confirmation says ${impact.nodes}, the subtree is ${expected.size}`,
        );
      const removed = await bonsai.api('DELETE', `/api/nodes/${id}`);
      log.push(`delete ${id.slice(0, 8)} (${expected.size}): ${removed.status}`);
      if (removed.status === 200) {
        if (removed.body.removed !== impact.nodes)
          fail(
            '4 delete = confirmation',
            `removed ${removed.body.removed}, listed ${impact.nodes}`,
          );
        for (const node of expected) model.delete(node);
      } else fail('4 delete = confirmation', `delete failed: ${JSON.stringify(removed.body)}`);
    }
    await check();
    if (failures.length > 0) break;
  }

  const { repo } = database(project.projectId);
  // Every project Bonsai creates reports git's empty tree as missing until a
  // gc writes it (a separate finding); anything else is real.
  const known = /missing tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904/;
  const fsck = spawnSync('git', ['fsck', '--no-progress', '--no-dangling'], { cwd: repo })
    .stdout.toString()
    .split('\n')
    .filter((line) => line.trim() !== '' && !known.test(line))
    .join('; ');
  console.log(`seed ${seed}: ${log.length} steps, ${model.size} experiments at the end`);
  const done = (op) => log.filter((l) => l.startsWith(op) && / (200|201|ready)$/.test(l)).length;
  console.log(
    `succeeded: create ${done('create')}, run ${done('run')}, archive and restore ${done('archive')}, delete ${done('delete')}`,
  );
  console.log(`git fsck: ${fsck === '' ? 'clean' : fsck}`);
  if (failures.length === 0) console.log('every rule held after every step');
  else {
    console.log(failures.join('\n'));
    console.log(`last steps:\n  ${log.slice(-8).join('\n  ')}`);
  }
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
