/**
 * Audit phase 7: a run with the real Claude Code when the API fails.
 *
 *   npm run build:server && node scripts/audit/api-failures.mjs [case ...]
 *
 * Bonsai runs with the real agent (the Claude Code its SDK bundles), pointed
 * at fake-api.mjs, so nothing is spent and every failure is on cue. Each case
 * is a fresh experiment whose agent first writes a file with Bash, then meets
 * the failure on its next request. Reported: how the run ended, what the
 * conversation says, whether the half-done work was committed as a finished
 * run, and what Bonsai thinks of its connection afterwards.
 *
 * Cases: ok, key (401: a revoked or wrong key), billing (no credit), rate
 * (429 on every retry), overloaded (529 on every retry), hang (no answer;
 * Stop pressed after 5 s), cost (three plain runs of one experiment).
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startFakeApi } from './fake-api.mjs';
import { delay, startBonsai } from './lib.mjs';

const ALL = ['ok', 'key', 'billing', 'rate', 'overloaded', 'hang', 'cost'];
const cases = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const fake = await startFakeApi();
const root = await mkdtemp(join(tmpdir(), 'bonsai-apifail-'));
const home = join(root, 'home');
await mkdir(home);
const bonsai = await startBonsai(
  join(root, 'data'),
  { HOME: home, ANTHROPIC_BASE_URL: fake.url },
  { realAgent: true },
);

const writeThen = (failure, retries = 1) => [
  'bash:echo partial > partial.txt',
  ...Array(retries).fill(failure),
];

try {
  await bonsai.api('PATCH', '/api/settings', {
    authMode: 'api_key',
    apiKey: 'sk-ant-api03-audit-not-a-real-key',
  });
  const check = await bonsai.api('POST', '/api/connection/check');
  console.log(`connection check against the fake API: ${check.body?.state}`);
  const project = (await bonsai.api('POST', '/api/projects', { name: 'api', description: '' }))
    .body;
  const db = new DatabaseSync(join(root, 'data', 'bonsai.db'), { readOnly: true });
  const repo = db
    .prepare('SELECT repo_path FROM project WHERE id = ?')
    .get(project.projectId).repo_path;
  db.close();

  const experiment = async (name) =>
    (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: name,
        description: '',
      })
    ).body.node.id;

  const report = async (name, id, started) => {
    const detail = (await bonsai.api('GET', `/api/nodes/${id}`)).body;
    const run = detail.runs.at(-1);
    const said = (await bonsai.api('GET', `/api/nodes/${id}/messages`)).body;
    const lastText = (Array.isArray(said) ? said : (said?.messages ?? []))
      .filter((m) => m.role === 'assistant' && m.kind === 'text')
      .at(-1);
    const text =
      typeof lastText?.content === 'string'
        ? lastText.content
        : JSON.stringify(lastText?.content ?? '');
    let committed = 'no commit';
    if (run.commitSha !== null) {
      const files = execFileSync('git', ['show', '--name-only', '--format=', run.commitSha], {
        cwd: repo,
      })
        .toString()
        .trim()
        .split('\n');
      committed = `committed: ${files.join(', ')}`;
    }
    const connection = (await bonsai.api('GET', '/api/connection')).body;
    console.log(`\n[${name}] ${Math.round((Date.now() - started) / 1000)} s`);
    console.log(
      `  experiment: ${detail.node.status}; run: ${run.status}/${run.endReason}; ${committed}`,
    );
    if (run.error) console.log(`  run error: ${run.error.split('\n')[0].slice(0, 160)}`);
    console.log(`  last thing the agent "said": ${text.split('\n')[0].slice(0, 160)}`);
    console.log(
      `  connection afterwards: ${connection.state}${connection.message ? ` (${connection.message.slice(0, 100)})` : ''}`,
    );
    return { detail, run };
  };

  const scenario = async (name, steps, { stopAfterMs } = {}) => {
    const id = await experiment(name);
    fake.script(...steps);
    const before = fake.requests.length;
    const started = Date.now();
    const start = await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: name });
    if (start.status >= 400) {
      console.log(
        `\n[${name}] could not start: HTTP ${start.status} ${JSON.stringify(start.body)}`,
      );
      return;
    }
    if (stopAfterMs !== undefined) {
      await delay(stopAfterMs);
      const pressed = Date.now();
      await bonsai.api('POST', `/api/nodes/${id}/cancel`);
      await bonsai.settle(id);
      console.log(`\n[${name}] Stop took ${Date.now() - pressed} ms to take effect`);
    } else {
      // What the card and panel can show while the agent waits on the API.
      const seen = new Set();
      for (;;) {
        const now = (await bonsai.api('GET', `/api/nodes/${id}`)).body;
        if (!['running', 'needs_you'].includes(now.node.status)) break;
        const a = now.node.activity;
        seen.add(a === null ? 'no activity' : `${a.state}${a.tool ? ` (${a.tool.name})` : ''}`);
        await delay(1000);
      }
      if (seen.size > 0)
        console.log(
          `\n[${name}] while running, the interface could show: ${[...seen].join(' / ')}`,
        );
    }
    fake.script();
    const main = fake.requests.slice(before).filter((r) => r.mainLoop);
    const { detail, run } = await report(name, id, started);
    if (['key', 'billing', 'rate', 'overloaded'].includes(name)) {
      assert.equal(run.status, 'failed');
      assert.equal(
        run.commitSha,
        null,
        'failed API calls must not commit partial work as finished',
      );
      assert.ok(
        JSON.stringify(detail.partialWork).includes('partial.txt'),
        'partial file stays recoverable',
      );
      assert.ok(Date.now() - started < 45000, 'retrying must be bounded');
      const connection = (await bonsai.api('GET', '/api/connection')).body;
      assert.equal(
        connection.state,
        name === 'key' ? 'no_credential' : name === 'billing' ? 'error' : 'connected',
      );
    }
    console.log(
      `  requests from the agent's loop: ${main.length} (${main.map((r) => r.step).join(', ')})`,
    );
    await bonsai.api('POST', '/api/connection/check');
  };

  for (const name of cases) {
    if (name === 'ok') await scenario('ok', ['bash:echo one > one.txt', 'text']);
    if (name === 'key') await scenario('key', writeThen(401, 15));
    if (name === 'billing') await scenario('billing', writeThen('billing', 15));
    if (name === 'rate') await scenario('rate', writeThen(429, 15));
    if (name === 'overloaded') await scenario('overloaded', writeThen(529, 15));
    if (name === 'hang') await scenario('hang', ['hang'], { stopAfterMs: 5000 });
    if (name === 'cost') {
      const id = await experiment('cost');
      for (let i = 0; i < 3; i++) {
        fake.script('text');
        await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `run ${i + 1}` });
        await bonsai.settle(id);
      }
      const runs = (await bonsai.api('GET', `/api/nodes/${id}`)).body.runs;
      console.log('\n[cost] three identical runs of one experiment (each one API call):');
      for (const run of runs)
        console.log(
          `  run: $${run.costUsd.toFixed(4)}, input tokens ${run.inputTokens}, output tokens ${run.outputTokens}`,
        );
      const usage = (await bonsai.api('GET', `/api/projects/${project.projectId}/usage`)).body;
      console.log(`  project usage reports: ${JSON.stringify(usage).slice(0, 200)}`);
      const captured = new DatabaseSync(join(root, 'data', 'bonsai.db'), { readOnly: true });
      const costs = captured
        .prepare(
          "SELECT data_json FROM sdk_session_entry WHERE json_extract(data_json, '$.type') = 'cost-state' ORDER BY id",
        )
        .all();
      const total = JSON.parse(costs.at(-1).data_json).totalCostUSD;
      captured.close();
      assert.equal(
        runs.every((run) => run.usageStatus === 'recorded'),
        true,
      );
      assert.ok(
        Math.abs(runs[1].costUsd - runs[2].costUsd) < 1e-9,
        'equal resumed requests have equal cost',
      );
      assert.equal(runs[1].inputTokens, 1000);
      assert.equal(runs[2].outputTokens, 100);
      assert.ok(
        Math.abs(runs.reduce((sum, run) => sum + run.costUsd, 0) - total) < 1e-9,
        'per-run estimates add up to the native session total',
      );

      const child = (
        await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId: id,
          displayName: 'native fork usage',
          description: '',
        })
      ).body.node.id;
      fake.script('text');
      await bonsai.api('POST', `/api/nodes/${child}/runs`, { prompt: 'continue child' });
      await bonsai.settle(child);
      const childRun = (await bonsai.api('GET', `/api/nodes/${child}`)).body.runs.at(-1);
      assert.equal(childRun.usageStatus, 'recorded');
      assert.ok(
        childRun.costUsd > 0 && childRun.costUsd < total,
        'native fork counts its own new work',
      );
      assert.equal(childRun.inputTokens, 1000, 'fork does not count parent tokens');

      const comparison = (
        await bonsai.api('POST', `/api/projects/${project.projectId}/comparisons`, {
          nodeIds: [id, child],
        })
      ).body;
      for (let i = 0; i < 3; i++) {
        fake.script('text');
        const accepted = await bonsai.api('POST', `/api/comparisons/${comparison.id}/messages`, {
          prompt: `question ${i}`,
        });
        assert.equal(accepted.status, 202);
        let finished = false;
        for (let attempt = 0; attempt < 600; attempt++) {
          const view = (await bonsai.api('GET', `/api/comparisons/${comparison.id}`)).body;
          if (view.turns.at(-1)?.status !== 'running') {
            assert.equal(view.turns.at(-1).status, 'done');
            finished = true;
            break;
          }
          await delay(100);
        }
        assert.equal(finished, true, 'comparison completed');
      }
      fake.script('text');
      const draft = await bonsai.api('POST', '/api/references/draft', {
        comparisonId: comparison.id,
        instruction: 'Summarize the comparison.',
      });
      assert.equal(draft.status, 200);
      const before = (await bonsai.api('GET', `/api/projects/${project.projectId}/usage`)).body;
      const questions = before.comparisons.find((row) => row.id === comparison.id).runs;
      assert.equal(
        questions.every((turn) => turn.usageStatus === 'recorded'),
        true,
      );
      assert.ok(
        Math.abs(questions[1].costUsd - questions[2].costUsd) < 1e-9,
        'comparison resumes subtract earlier questions',
      );
      assert.equal(questions[2].inputTokens, 1000);
      assert.equal(before.drafts[0].usageStatus, 'recorded');
      assert.ok(before.drafts[0].costUsd > 0, 'tool-less reference call is counted');
      const entries = (view) =>
        [...view.experiments, ...view.comparisons].flatMap((row) => row.runs).concat(view.drafts);
      const sum = (view) => entries(view).reduce((sum, run) => sum + run.costUsd, 0);
      await bonsai.api('DELETE', `/api/nodes/${id}`);
      await bonsai.api('DELETE', `/api/comparisons/${comparison.id}`);
      const after = (await bonsai.api('GET', `/api/projects/${project.projectId}/usage`)).body;
      assert.equal(
        sum(after),
        sum(before),
        'deleting experiments and comparisons preserves usage totals',
      );
      assert.equal(after.experiments.find((row) => row.id === id).deleted, true);
      assert.equal(after.comparisons.find((row) => row.id === comparison.id).deleted, true);
      console.log(
        '  PASS: resumed and forked runs, comparison questions, reference draft and deletion-safe totals',
      );
    }
  }
} finally {
  await bonsai.stop();
  await fake.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
