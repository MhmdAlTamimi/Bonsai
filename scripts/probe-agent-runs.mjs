/**
 * Checks how Bonsai's runner ends runs, against the REAL Claude Agent SDK.
 *
 * THIS MAKES PAID MODEL CALLS. It is not part of `npm test` and never should
 * be. It uses the cheapest model and a throwaway folder per probe; a full run
 * costs a few cents at API-equivalent prices and takes about a minute.
 *
 * Why it exists (D43): a real run ended when the agent's turn ended, while
 * the `uv sync` and batch job it had started were still running. Bonsai
 * committed, said Finished, and the harness stopped the tracked job seconds
 * later. The unit tests pin Bonsai's rule for when a run is over; only the
 * real harness can show that a held-open session lets the job finish, wakes
 * the agent, and stops what it should when told to.
 *
 *   npm run build:server && node scripts/probe-agent-runs.mjs
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeSdkRunner } from '../packages/server/dist/agent/ClaudeSdkRunner.js';
import { findLeftovers, roots, stopLeftovers } from '../packages/server/dist/jobs/leftovers.js';

const MODEL = process.env['BONSAI_PROBE_MODEL'] ?? 'claude-haiku-4-5';

/**
 * Runs one prompt through Bonsai's runner. `onWaiting` is called the first
 * time the run reports it is waiting for background work.
 */
async function run(prompt, { onWaiting, files = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'bonsai-probe-runs-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(cwd, name), content);
    chmodSync(join(cwd, name), 0o755);
  }
  const stop = new AbortController();
  const finish = new AbortController();
  const started = Date.now();
  const runId = randomUUID();
  let waited = false;
  let untracked = false;
  let text = '';
  let error = null;
  const spec = {
    runId,
    nodeId: 'probe',
    cwd,
    prompt,
    resumeSessionId: null,
    readOnly: false,
    successCriteria: null,
    verificationHint: null,
    model: MODEL,
    effort: null,
    permissionMode: 'acceptEdits',
    agentEnv: null,
    ask: null,
    askChoices: null,
    signal: stop.signal,
    finishNow: finish.signal,
    onActivity: (activity) => {
      if (activity.background.some((job) => !job.tracked)) untracked = true;
      if (activity.state !== 'waiting' || waited) return;
      waited = true;
      onWaiting?.({ stop, finish });
    },
    // What the pipeline supplies: this run's detached processes, by marker.
    backgroundLeftovers: async () =>
      roots(await findLeftovers(runId)).map((p) => ({
        id: `pid:${p.pid}`,
        description: p.command,
        tracked: false,
        startedAt: new Date().toISOString(),
      })),
  };
  try {
    for await (const event of new ClaudeSdkRunner().run(spec)) {
      if (event.type === 'text') text = event.text;
      if (event.type === 'error') error = event.error;
    }
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 160);
  }
  // What the pipeline does once the runner returns.
  const leftovers = await stopLeftovers(runId);
  const marker = existsSync(join(cwd, 'marker.txt'));
  rmSync(cwd, { recursive: true, force: true });
  return {
    seconds: Math.round((Date.now() - started) / 1000),
    waited,
    untracked,
    leftovers: leftovers.length,
    marker,
    text: text.slice(0, 80),
    error,
  };
}

/** Whether a process whose command line contains `needle` is still alive. */
function alive(needle) {
  try {
    return execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

const results = [];
let failed = false;
const check = (name, ok, detail) => {
  results.push({ check: name, ok, ...detail });
  if (!ok) failed = true;
};

// Durations are odd numbers so `pgrep` finds only this probe's processes.
const background = (seconds) =>
  `Use the Bash tool with run_in_background set to true to run exactly: ` +
  `sleep ${seconds} && echo done > marker.txt . Do not poll it. End your turn at once by ` +
  `replying exactly WAITING. When you are notified that it finished, reply exactly FINISHED.`;

{
  const outcome = await run(background(13));
  check(
    'a tracked background job keeps the run open until it finishes, and the agent is woken',
    outcome.waited && outcome.marker && outcome.text.includes('FINISHED') && outcome.error === null,
    outcome,
  );
}

{
  const outcome = await run(background(127), { onWaiting: ({ finish }) => finish.abort() });
  await new Promise((r) => setTimeout(r, 2000));
  const leftover = alive('sleep 127');
  check(
    'Finish now stops the job and ends the run without an error',
    outcome.waited &&
      !outcome.marker &&
      outcome.error === null &&
      outcome.seconds < 60 &&
      !leftover,
    { ...outcome, leftover },
  );
}

{
  const outcome = await run(background(131), { onWaiting: ({ stop }) => stop.abort() });
  await new Promise((r) => setTimeout(r, 2000));
  const leftover = alive('sleep 131');
  check('Stop leaves nothing running', outcome.waited && !leftover, { ...outcome, leftover });
}

// The agent is told never to detach, and asked outright it refuses. So the
// detaching happens inside a script it is asked to run, the way a tool that
// daemonises itself would do it -- the case detection exists for.
{
  const outcome = await run(
    'Run ./start.sh with the Bash tool (not in background mode). It starts a job and returns ' +
      'at once. Then end your turn immediately by replying exactly WAITING. When you are told ' +
      'the process has exited, reply exactly FINISHED.',
    {
      files: {
        'start.sh':
          "#!/bin/sh\nnohup sh -c 'sleep 17; echo done > marker.txt' > /dev/null 2>&1 &\necho started\n",
      },
    },
  );
  check(
    'a job detached inside a script is found by its marker, waited for, and the agent is told when it exits',
    outcome.untracked && outcome.marker && outcome.text.includes('FINISHED'),
    outcome,
  );
}

console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
