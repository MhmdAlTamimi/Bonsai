/**
 * Audit phase 5: kill Bonsai at random moments during runs, and check what
 * a restart leaves you with.
 *
 *   npm run build:server && node scripts/audit/chaos.mjs [iterations] [seed]
 *
 * One project Bonsai created. Each round makes a fresh experiment, gives it a
 * folder with one clean run, starts a second run, kills the server (SIGKILL:
 * what a crash, a closed laptop or a killed terminal does) somewhere between
 * the agent's work and the commit, restarts it on the same data folder, and
 * checks:
 *
 *   - nothing is still recorded as running;
 *   - every experiment's hidden ref points where the database says its code is;
 *   - no git lock file is left behind;
 *   - the experiment can be brought back (Discard when it is interrupted) and
 *     its next run commits.
 *
 * Kill times are drawn from a seeded generator, so a failure can be replayed
 * with the same seed. Uses a temporary data folder and the stand-in agent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { delay, startBonsai } from './lib.mjs';

const iterations = Number(process.argv[2] ?? 80);
const seed = Number(process.argv[3] ?? Math.floor(Math.random() * 2 ** 31));
let state = seed;
/** mulberry32: small, fast and good enough to spread kill times. */
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const root = await mkdtemp(join(tmpdir(), 'bonsai-chaos-'));
const dataDir = join(root, 'data');
const env = { BONSAI_FAKE_DELAY_MS: '150' };
const anomalies = new Map();
const note = (kind, detail) => {
  const key = `${kind}: ${detail}`;
  anomalies.set(key, (anomalies.get(key) ?? 0) + 1);
};

function recorded(projectId) {
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const project = db.prepare('SELECT repo_path FROM project WHERE id = ?').get(projectId);
  const nodes = db
    .prepare('SELECT id, status, head_commit, base_commit FROM node WHERE project_id = ?')
    .all(projectId);
  const running = db.prepare("SELECT count(*) AS n FROM run WHERE status = 'running'").get().n;
  db.close();
  return { repo: project.repo_path, nodes, running };
}

function refs(repo, projectId) {
  const out = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname) %(objectname)', `refs/bonsai/${projectId}/`],
    {
      cwd: repo,
    },
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

function locks(repo) {
  const dir = join(repo, 'worktrees');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'index.lock')));
}

let bonsai = await startBonsai(dataDir, env);
const outcomes = { finishedBeforeKill: 0, recovered: 0, stuck: 0 };
const stuckAt = [];
const recoveredAt = [];
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'chaos', description: '' }))
    .body;

  for (let round = 0; round < iterations; round++) {
    // A fresh experiment each round, with its folder made by one clean run, so
    // rounds are independent: one stuck experiment cannot fail the next round.
    const nodeId = (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: `round ${round}`,
        description: '',
      })
    ).body.node.id;
    await bonsai.api('POST', `/api/nodes/${nodeId}/runs`, { prompt: 'first' });
    await bonsai.settle(nodeId);

    const started = performance.now();
    await bonsai.api('POST', `/api/nodes/${nodeId}/runs`, { prompt: `round ${round}` });
    await delay(100 + Math.floor(random() * 460));
    const killedAt = Math.round(performance.now() - started);
    await bonsai.stop();

    bonsai = await startBonsai(dataDir, env);
    const after = recorded(project.projectId);
    if (after.running > 0) note('still running after restart', `${after.running} run(s)`);
    const node = after.nodes.find((n) => n.id === nodeId);
    const ref = refs(after.repo, project.projectId).get(nodeId);
    if (ref !== undefined && ref !== (node.head_commit ?? node.base_commit))
      note('ref and database disagree', 'the ref moved, the database did not');
    for (const name of locks(after.repo))
      note('git lock file left behind', `worktrees/${name.slice(0, 8)}…/index.lock`);

    if (node.status !== 'interrupted') {
      outcomes.finishedBeforeKill += 1;
      continue;
    }
    const discard = await bonsai.api('POST', `/api/nodes/${nodeId}/recover`, {
      action: 'discard',
    });
    if (discard.status !== 200)
      note('Discard refused', String(discard.body?.error ?? discard.body).slice(0, 120));
    await bonsai.api('POST', `/api/nodes/${nodeId}/runs`, { prompt: `after round ${round}` });
    const next = (await bonsai.settle(nodeId)).body;
    if (next?.node?.status === 'ready') {
      outcomes.recovered += 1;
      recoveredAt.push(killedAt);
    } else {
      outcomes.stuck += 1;
      stuckAt.push(killedAt);
      note(
        'next run after Discard',
        `${next?.node?.status}: ${(next?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 120)}`,
      );
    }
  }

  const final = recorded(project.projectId);
  const fsck = spawnSync('git', ['fsck', '--no-progress', '--no-dangling'], { cwd: final.repo });
  const range = (list) =>
    list.length === 0 ? '-' : `${Math.min(...list)}-${Math.max(...list)} ms`;
  console.log(`seed ${seed}, ${iterations} kills, each in a fresh experiment`);
  console.log(JSON.stringify(outcomes));
  console.log(
    `killed at, for experiments left stuck: ${range(stuckAt)}; recovered: ${range(recoveredAt)}`,
  );
  console.log(
    `git fsck: exit ${fsck.status}${String(fsck.stdout).trim() ? `, ${String(fsck.stdout).trim().split('\n')[0]}` : ''}`,
  );
  if (anomalies.size === 0) console.log('no anomalies');
  for (const [what, count] of anomalies) console.log(`${count}× ${what}`);
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
