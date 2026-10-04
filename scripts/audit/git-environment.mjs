/**
 * Audit phase 4: what the user's git setup does to Bonsai's experiments.
 *
 *   npm run build:server && node scripts/audit/git-environment.mjs
 *
 * Each case is its own repository and its own Bonsai, run with the stand-in
 * agent (which writes a note file and CONTEXT.md, then Bonsai commits):
 *
 *   hooks      a pre-commit hook that fails, as husky does before
 *              `npm install`, and a post-checkout hook that records where it ran
 *   global     the same failing hook set for every repository through
 *              core.hooksPath in ~/.gitconfig, on a project Bonsai created
 *   noprefix   diff.noprefix = true in ~/.gitconfig, then Apply
 *   system     a content filter defined only in git's system config — where
 *              Git for Windows puts Git LFS's filter
 *   submodule  a repository with a submodule
 *   upkeep     git gc --prune=now and git worktree prune in the user's folder,
 *              with one experiment archived, then Review, a run and Apply
 *   context    a repository that already has its own CONTEXT.md
 *   parallel   six experiments of one repository committing at once, three times
 *
 * One case alone: node scripts/audit/git-environment.mjs hooks
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-gitenv-'));
const only = process.argv[2];

/** A repository with one commit, built with an explicit environment. */
async function makeRepo(name, files, env = gitEnv) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: path, env }).toString();
  git('init', '-q', '--initial-branch=main');
  for (const [file, body] of Object.entries(files)) {
    await mkdir(join(path, file, '..'), { recursive: true });
    await writeFile(join(path, file), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'first');
  return { path, git };
}

async function hook(dir, name, body) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, name), 0o755);
}

/** Adopts `path`, branches one experiment and runs it once. */
async function adoptAndRun(bonsai, path) {
  const project = (await bonsai.api('POST', '/api/projects/adopt', { path, description: '' })).body;
  const child = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'try',
      description: '',
    })
  ).body.node;
  await bonsai.api('POST', `/api/nodes/${child.id}/runs`, { prompt: 'try it' });
  const detail = (await bonsai.settle(child.id)).body;
  return { project, child, detail, folder: worktreeOf(path, child.id) };
}

function worktreeOf(repo, nodeId) {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
    .toString()
    .split('\n')
    .find((line) => line.startsWith('worktree ') && line.includes(nodeId))
    ?.slice('worktree '.length);
}

const outcome = (detail) =>
  `${detail.node.status}${detail.runs.at(-1)?.error ? ` — ${detail.runs.at(-1).error.split('\n')[0]}` : ''}`;

const cases = {
  async hooks() {
    const repo = await makeRepo('hooks', { 'app.txt': 'one\n' });
    const marker = join(root, 'post-checkout.log');
    await hook(
      join(repo.path, '.git', 'hooks'),
      'pre-commit',
      'echo "husky - pre-commit script failed (code 127)" >&2; exit 1',
    );
    await hook(join(repo.path, '.git', 'hooks'), 'post-checkout', `pwd >> "${marker}"`);
    const bonsai = await startBonsai(join(root, 'data-hooks'));
    try {
      const { detail } = await adoptAndRun(bonsai, repo.path);
      console.log(`  the run: ${outcome(detail)}`);
      console.log(`  your post-checkout hook ran: ${existsSync(marker)}`);
    } finally {
      await bonsai.stop();
    }
  },

  async global() {
    const home = join(root, 'home-global');
    await hook(join(home, 'hooks'), 'pre-commit', 'echo "lint failed" >&2; exit 1');
    await writeFile(join(home, '.gitconfig'), `[core]\n\thooksPath = ${join(home, 'hooks')}\n`);
    const bonsai = await startBonsai(join(root, 'data-global'), { HOME: home });
    try {
      const created = (
        await bonsai.api('POST', '/api/projects', { name: 'fresh', description: '' })
      ).body;
      await bonsai.api('POST', `/api/nodes/${created.masterNodeId}/runs`, { prompt: 'go' });
      console.log(
        `  a run in a project Bonsai created: ${outcome((await bonsai.settle(created.masterNodeId)).body)}`,
      );
    } finally {
      await bonsai.stop();
    }
  },

  async noprefix() {
    const home = join(root, 'home-noprefix');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.gitconfig'), '[diff]\n\tnoprefix = true\n');
    const repo = await makeRepo('noprefix', { 'src/app.txt': 'one\n' });
    const bonsai = await startBonsai(join(root, 'data-noprefix'), { HOME: home });
    try {
      const { child, detail } = await adoptAndRun(bonsai, repo.path);
      console.log(`  the run: ${outcome(detail)}`);
      const review = await bonsai.api('GET', `/api/nodes/${child.id}/review`);
      console.log(
        `  review: HTTP ${review.status}, files: ${review.body.files?.map((f) => f.path).join(', ')}`,
      );
      const patch = (await bonsai.api('POST', `/api/nodes/${child.id}/patch`)).body;
      const head = (await readFile(patch.path, 'utf8')).split('\n')[0];
      console.log(`  the patch starts: ${head}`);
      try {
        execFileSync('sh', ['-c', patch.command], { cwd: root, env: { ...gitEnv, HOME: home } });
        const landed = repo.git('status', '--short', '--untracked-files=all').trim().split('\n');
        console.log(`  Apply: "applied" — your folder now has: ${landed.join(', ')}`);
      } catch (error) {
        console.log(`  Apply: failed — ${String(error.stderr).trim().split('\n')[0]}`);
      }
    } finally {
      await bonsai.stop();
    }
  },

  async system() {
    const systemConfig = join(root, 'system-gitconfig');
    await writeFile(
      systemConfig,
      '[filter "demo"]\n\tsmudge = sed s/STORED/CHECKED-OUT/\n\tclean = sed s/CHECKED-OUT/STORED/\n\trequired = true\n',
    );
    const env = { ...gitEnv, GIT_CONFIG_SYSTEM: systemConfig };
    const repo = await makeRepo(
      'system',
      { '.gitattributes': '*.dat filter=demo\n', 'data.dat': 'CHECKED-OUT\n' },
      env,
    );
    const bonsai = await startBonsai(join(root, 'data-system'), {
      GIT_CONFIG_SYSTEM: systemConfig,
    });
    try {
      const { folder, detail } = await adoptAndRun(bonsai, repo.path);
      console.log(
        `  your checkout has:        ${(await readFile(join(repo.path, 'data.dat'), 'utf8')).trim()}`,
      );
      console.log(
        `  the experiment's has:     ${(await readFile(join(folder, 'data.dat'), 'utf8')).trim()}`,
      );
      console.log(`  the run: ${outcome(detail)}`);
    } finally {
      await bonsai.stop();
    }
  },

  async submodule() {
    const lib = await makeRepo('lib', { 'lib.txt': 'library code\n' });
    const repo = await makeRepo('with-submodule', { 'app.txt': 'one\n' });
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.path, 'lib'],
      {
        cwd: repo.path,
        env: gitEnv,
      },
    );
    repo.git('commit', '-qm', 'add lib');
    const bonsai = await startBonsai(join(root, 'data-submodule'));
    try {
      const { folder, detail } = await adoptAndRun(bonsai, repo.path);
      console.log(
        `  your lib/ holds: ${(await readdir(join(repo.path, 'lib'))).filter((f) => f !== '.git').join(', ')}`,
      );
      console.log(
        `  the experiment's lib/ holds: ${(await readdir(join(folder, 'lib'))).join(', ') || '(nothing)'}`,
      );
      console.log(`  the run: ${outcome(detail)}`);
    } finally {
      await bonsai.stop();
    }
  },

  async upkeep() {
    const repo = await makeRepo('upkeep', { 'app.txt': 'one\n' });
    const bonsai = await startBonsai(join(root, 'data-upkeep'));
    try {
      const { project, child } = await adoptAndRun(bonsai, repo.path);
      const second = (
        await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId: project.masterNodeId,
          displayName: 'archived',
          description: '',
        })
      ).body.node;
      await bonsai.api('POST', `/api/nodes/${second.id}/runs`, { prompt: 'work' });
      await bonsai.settle(second.id);
      const archived = await bonsai.api('POST', `/api/nodes/${second.id}/archive`, {});
      console.log(`  archived one experiment: HTTP ${archived.status}`);
      repo.git('gc', '--prune=now', '--quiet');
      repo.git('worktree', 'prune');
      console.log('  ran git gc --prune=now and git worktree prune in your folder');
      const review = await bonsai.api('GET', `/api/nodes/${child.id}/review`);
      console.log(`  review: HTTP ${review.status}`);
      await bonsai.api('POST', `/api/nodes/${second.id}/runs`, { prompt: 'more' });
      console.log(
        `  the archived experiment runs again: ${outcome((await bonsai.settle(second.id)).body)}`,
      );
      const patch = (await bonsai.api('POST', `/api/nodes/${second.id}/patch`)).body;
      execFileSync('sh', ['-c', patch.command], { cwd: root, env: gitEnv });
      console.log('  Apply: applied');
    } finally {
      await bonsai.stop();
    }
  },

  async context() {
    const ours = '# Team context\n\nAlways use pnpm, never npm.\n';
    const repo = await makeRepo('context', { 'CONTEXT.md': ours, 'app.txt': 'one\n' });
    const bonsai = await startBonsai(join(root, 'data-context'));
    try {
      const { child, detail } = await adoptAndRun(bonsai, repo.path);
      console.log(`  the run: ${outcome(detail)}`);
      const kept = execFileSync('git', ['show', `${detail.runs.at(-1).commitSha}:CONTEXT.md`], {
        cwd: repo.path,
      }).toString();
      console.log(
        `  your CONTEXT.md in the experiment still says "use pnpm": ${kept.includes('pnpm')}`,
      );
      const review = (await bonsai.api('GET', `/api/nodes/${child.id}/review`)).body;
      console.log(`  Review lists: ${review.files.map((f) => f.path).join(', ')}`);
      const patch = (await bonsai.api('POST', `/api/nodes/${child.id}/patch`)).body;
      console.log(
        `  Apply's patch includes CONTEXT.md: ${(await readFile(patch.path, 'utf8')).includes('CONTEXT.md')}`,
      );
    } finally {
      await bonsai.stop();
    }
  },

  async parallel() {
    const repo = await makeRepo('parallel', { 'a.txt': 'a\n' });
    const bonsai = await startBonsai(join(root, 'data-parallel'), { BONSAI_FAKE_DELAY_MS: '300' });
    try {
      await bonsai.api('PATCH', '/api/settings', { maxConcurrentRuns: 6 });
      const project = (
        await bonsai.api('POST', '/api/projects/adopt', { path: repo.path, description: '' })
      ).body;
      for (let round = 1; round <= 3; round++) {
        const ids = [];
        for (let i = 0; i < 6; i++)
          ids.push(
            (
              await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
                parentId: project.masterNodeId,
                displayName: `round ${round} #${i}`,
                description: '',
              })
            ).body.node.id,
          );
        await Promise.all(
          ids.map((id) =>
            bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `round ${round}` }),
          ),
        );
        const done = (await Promise.all(ids.map((id) => bonsai.settle(id)))).filter(
          (r) => r.body.node.status === 'ready',
        ).length;
        console.log(`  round ${round}: ${done} of 6 committed`);
      }
      const fsck = repo.git('fsck', '--no-progress').trim();
      console.log(`  git fsck: ${fsck === '' ? 'clean' : fsck}`);
    } finally {
      await bonsai.stop();
    }
  },
};

try {
  for (const [name, run] of Object.entries(cases)) {
    if (only !== undefined && only !== name) continue;
    console.log(`${name}:`);
    try {
      await run();
    } catch (error) {
      console.log(`  (case failed to run: ${error.message.split('\n')[0]})`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
