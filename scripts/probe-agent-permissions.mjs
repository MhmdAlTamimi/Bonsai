/**
 * Checks Bonsai's agent permissions against the REAL Claude Agent SDK.
 *
 * THIS MAKES PAID MODEL CALLS. It is not part of `npm test` and never should
 * be. It uses the cheapest model, a throwaway folder per probe, and a handful
 * of turns; a full run costs a few cents at API-equivalent prices.
 *
 * Why it exists: the unit tests can pin Bonsai's CONFIGURATION, but not what
 * the SDK does with it, and two real bugs lived in that gap --
 *
 *   read-only runs could write, because `allowedTools` only pre-approves and a
 *   permissive mode approves writes before any list is consulted;
 *
 *   the agent's questions never reached the user, because the SDK delivers an
 *   answer only as `answers` in the tool input returned by the permission
 *   callback, and nothing ever filled it in.
 *
 * Both were beliefs about the SDK that nobody had checked. This checks them,
 * using Bonsai's own compiled configuration rather than a copy of it.
 *
 *   npm run build:server && node scripts/probe-agent-permissions.mjs
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { permissionOptions } from '../packages/server/dist/agent/ClaudeSdkRunner.js';

const MODEL = process.env['BONSAI_PROBE_MODEL'] ?? 'claude-haiku-4-5';

function spec(overrides) {
  return {
    runId: 'probe',
    nodeId: 'probe',
    cwd: '',
    prompt: '',
    resumeSessionId: null,
    forkSession: false,
    readOnly: false,
    successCriteria: null,
    verificationHint: null,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    agentEnv: null,
    ask: null,
    askChoices: null,
    signal: new AbortController().signal,
    finishNow: new AbortController().signal,
    onActivity: () => undefined,
    ...overrides,
  };
}

/** Runs one prompt with Bonsai's options and reports what actually happened. */
async function run(prompt, runSpec) {
  const cwd = mkdtempSync(join(tmpdir(), 'bonsai-probe-'));
  let text = '';
  let outcome = null;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        model: MODEL,
        maxTurns: 8,
        settingSources: [],
        ...permissionOptions({ ...runSpec, cwd }),
      },
    })) {
      if (message.type === 'assistant')
        for (const block of message.message.content) if (block.type === 'text') text = block.text;
      if (message.type === 'result') outcome = message.subtype;
    }
  } catch (error) {
    outcome = `threw: ${String(error?.message ?? error).slice(0, 160)}`;
  }
  const wrote = existsSync(join(cwd, 'hello.txt'));
  rmSync(cwd, { recursive: true, force: true });
  return { text: text.slice(0, 120), outcome, wrote };
}

const results = [];
let failed = false;
const check = (name, ok, detail) => {
  results.push({ check: name, ok, ...detail });
  if (!ok) failed = true;
};

// -- read-only runs cannot change files, whatever the project's mode ---------
const WRITE =
  'Use the Write tool to create hello.txt containing hi. If that is refused, try any other ' +
  'tool that could create it. Then reply with exactly DONE or BLOCKED.';
for (const mode of ['acceptEdits', 'bypassPermissions']) {
  const outcome = await run(WRITE, spec({ readOnly: true, permissionMode: mode }));
  check(`read-only run under "${mode}" writes nothing`, !outcome.wrote, outcome);
}

// -- the agent's questions reach the user, in every mode (D42) ---------------
// The reported bug: AskUserQuestion returned at once with no answer and the
// agent announced it would wait. Answered through Bonsai's own callback, the
// agent must repeat back a free-text answer that is none of the options.
const ASK =
  "Use the AskUserQuestion tool exactly once to ask me which codename to use, header 'Codename', " +
  "options 'Purple-Walrus' and 'Green-Otter'. Then reply with exactly one line: CODENAME=<the answer you received>.";
const answering = {
  askChoices: (request) =>
    Promise.resolve({ answered: true, answers: { [request.questions[0].question]: 'Blue-Heron' } }),
};
for (const [label, overrides] of [
  ['acceptEdits', { permissionMode: 'acceptEdits' }],
  ['bypassPermissions', { permissionMode: 'bypassPermissions' }],
  ['default', { permissionMode: 'default' }],
  ['plan', { permissionMode: 'plan' }],
  ['a read-only run', { readOnly: true }],
]) {
  const outcome = await run(ASK, spec({ ...overrides, ...answering }));
  check(`question answered under ${label}`, outcome.text.includes('Blue-Heron'), outcome);
}

// Leaving it to the agent: it must carry on and choose, not stop to wait.
{
  const outcome = await run(
    ASK.replace('the answer you received', 'the codename you will use'),
    spec({
      askChoices: () =>
        Promise.resolve({
          answered: false,
          reason:
            'The user chose not to answer and left this decision to you. Make a reasonable ' +
            'choice, carry on, and say clearly in your reply what you decided and why.',
        }),
    }),
  );
  check('left to the agent, it decides', /CODENAME=\S+/.test(outcome.text), outcome);
}

console.log(JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
