/**
 * Audit phase 8: the agent runs a tool that commits by itself.
 *
 *   npm run build:server && node scripts/audit/agent-commits.mjs
 *
 * `npm version patch` — an ordinary thing to run in a JavaScript project —
 * makes a commit and a tag. Bonsai's git guard looks for `git commit` in the
 * command text, so it does not see this one. Runs it with the real Claude
 * Code (against fake-api.mjs) in a project added from a folder, then reports
 * how the run ended, whether Discard and a next run work, and whether the tag
 * reached your own repository.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeApi } from './fake-api.mjs';
import { gitEnv, startBonsai } from './lib.mjs';

const fake = await startFakeApi();
const root = await mkdtemp(join(tmpdir(), 'bonsai-agentcommit-'));
const home = join(root, 'home');
const repo = join(root, 'my-app');
await mkdir(home);
await mkdir(repo);
// A git identity, as anyone who commits has.
await writeFile(join(home, '.gitconfig'), '[user]\n\tname = You\n\temail = you@example.com\n');
const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv }).toString().trim();
git('init', '-q', '--initial-branch=main');
await writeFile(join(repo, 'package.json'), '{ "name": "my-app", "version": "1.0.0" }\n');
git('add', '-A');
git('commit', '-qm', 'first');

const bonsai = await startBonsai(
  join(root, 'data'),
  { HOME: home, ANTHROPIC_BASE_URL: fake.url },
  { realAgent: true },
);
const lastError = (detail) => (detail?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 150);
try {
  await bonsai.api('PATCH', '/api/settings', { authMode: 'api_key', apiKey: 'sk-ant-api03-audit' });
  await bonsai.api('POST', '/api/connection/check');
  const project = (await bonsai.api('POST', '/api/projects/adopt', { path: repo, description: '' }))
    .body;
  const id = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'bump',
      description: '',
    })
  ).body.node.id;

  fake.script('bash:npm version patch', 'text');
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'bump the version' });
  const after = (await bonsai.settle(id)).body;
  console.log(`run: ${after.node.status} — ${lastError(after)}`);
  console.log(`tags in your own repository now: ${git('tag', '--list') || '(none)'}`);

  const discard = await bonsai.api('POST', `/api/nodes/${id}/recover`, { action: 'discard' });
  console.log(
    `Discard: HTTP ${discard.status} ${discard.status >= 400 ? JSON.stringify(discard.body).slice(0, 150) : ''}`,
  );
  fake.script('text');
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'carry on' });
  const next = (await bonsai.settle(id)).body;
  console.log(`next run: ${next.node.status} — ${lastError(next)}`);
} finally {
  await bonsai.stop();
  await fake.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
