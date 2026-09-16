import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentQuestion } from '@bonsai/shared';
import type { AgentRunner, RunEvent, RunSpec } from './AgentRunner.js';
import { RUN_MARKER } from '../jobs/leftovers.js';

/**
 * The question the stand-in asks, shaped like a real one: a short header, two
 * options with descriptions, and a preview on one of them, so the panel's
 * handling of every part of the shape is exercised without a credential.
 */
export const FAKE_QUESTION: AgentQuestion = {
  question: 'Which approach should I take?',
  header: 'Approach',
  multiSelect: false,
  options: [
    { label: 'Keep it simple', description: 'The smallest change that does the job.' },
    {
      label: 'Make it configurable',
      description: 'More code, but the behaviour can be changed later without editing it.',
      preview: 'approach = "configurable"\nretries = 3',
    },
  ],
};

/**
 * Stands in for the agent so M2 can drive the git layer with fake file writes.
 *
 * The convention is one character, because it has to be usable from the browser
 * without a form for it:
 *
 *   a prompt starting with '?'  ->  writes nothing. Conversation only.
 *   anything else               ->  writes a file, so the node commits.
 *
 * Plus prefixes for paths that need a user in the loop: "choose:" asks a
 * question (D42); "background:" leaves a tracked job running after its turn,
 * and "detach:" a process started the way `nohup … &` starts one, so the run
 * waits for either (D43). "many files:" writes a few dozen files across nested
 * folders, which is what reviewing a large change needs (D44).
 *
 * That single rule is enough to exercise the emergent model end to end: the
 * same creation flow produces a node with a branch or a node without one, and
 * nothing anywhere had to be told which kind it was making.
 *
 * It writes CONTEXT.md on EVERY run, including the question-only ones, because
 * that is what D28 specifies and it is precisely the case the commit pipeline
 * has to get right -- a CONTEXT.md left behind by a no-op run would otherwise
 * ride into the next run's commit.
 */
export class FakeRunner implements AgentRunner {
  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    // Mirrors the real runner: a fork yields a NEW session id (the parent's is
    // left untouched), a resume keeps the one it was given.
    yield {
      type: 'session',
      sessionId:
        spec.resumeSessionId !== null && !spec.forkSession
          ? spec.resumeSessionId
          : `fake-${randomUUID()}`,
    };

    const question = spec.prompt.trimStart().startsWith('?');
    yield {
      type: 'text',
      text: question
        ? `Reading the code to answer: ${spec.prompt.trim()}`
        : `Working on: ${spec.prompt.trim()}`,
    };

    /**
     * D42: the stand-in asks the user something, too.
     *
     * A request starting with "choose:" puts a question to the user before
     * doing anything else -- in every permission mode, and on read-only
     * experiments, because asking changes nothing. The answer, or the lack of
     * one, is said back in the transcript the way a real agent would.
     */
    if (spec.prompt.trimStart().toLowerCase().startsWith('choose:') && spec.askChoices !== null) {
      const decision = await spec.askChoices({ questions: [FAKE_QUESTION] });
      if (spec.signal.aborted) return;
      yield {
        type: 'text',
        text: decision.answered
          ? `You chose: ${decision.answers[FAKE_QUESTION.question] ?? ''}.`
          : `Nobody chose, so I decided: Keep it simple. (${decision.reason})`,
      };
    }

    if (spec.readOnly) {
      yield { type: 'text', text: 'This node is frozen, so I can only read.' };
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return;
    }

    /**
     * The stand-in stands in for asking, too (D34).
     *
     * `ask` is non-null only under the `default` permission mode, so this is
     * silent unless the user chose "ask before each change" -- and when they
     * did, the whole path is drivable without a credential: the node parks,
     * the panel shows the question, and the answer comes back here.
     *
     * A refusal changes what it does rather than stopping it, because that is
     * what a refusal does to a real agent: the message is handed back as the
     * tool's result and the run carries on.
     */
    let refused: string | null = null;
    if (!question && spec.ask !== null) {
      const file = `notes/${slug(spec.prompt)}.md`;
      const decision = await spec.ask({ toolName: 'Write', detail: file });
      if (!decision.allow) refused = decision.reason;
      if (spec.signal.aborted) return;
      yield {
        type: 'text',
        text: refused === null ? 'Going ahead.' : `Told not to: ${refused}`,
      };
    }

    if (!question && refused === null) {
      const file = `notes/${slug(spec.prompt)}.md`;
      await writeInside(spec.cwd, file, `# ${spec.prompt.trim()}\n\nWritten by FakeRunner.\n`);
      yield { type: 'tool', name: 'Write', detail: file };
    }

    if (
      !question &&
      refused === null &&
      spec.prompt.trimStart().toLowerCase().startsWith('many files:')
    ) {
      for (let i = 1; i <= 36; i += 1) {
        const file = `src/module-${Math.ceil(i / 6)}/part ${i}.py`;
        const body = Array.from({ length: i * 3 }, (_, line) => `value_${line} = ${line * i}`);
        await writeInside(spec.cwd, file, `${body.join('\n')}\n`);
      }
      // One long file, so reading past the first thousand lines is reachable.
      await writeInside(
        spec.cwd,
        'data/generated/long table.csv',
        Array.from({ length: 1_500 }, (_, row) => `${row},${row * row}`).join('\n') + '\n',
      );
      yield { type: 'tool', name: 'Write', detail: '37 files' };
    }

    /**
     * D43: a request starting with "background:" starts a job, ends its turn,
     * and waits for the job the way a real session does -- until the job ends
     * (BONSAI_FAKE_BACKGROUND_MS), Finish now, or Stop. Finish now still lets
     * the run end normally and commit; Stop does not.
     */
    /**
     * D43: "detach:" starts a real process outside any tracking, carrying the
     * run's marker, and waits the way the real runner does -- by looking for
     * it -- so the pipeline's detection and its clean-up on Stop are what get
     * exercised, not a stand-in for them.
     */
    if (spec.prompt.trimStart().toLowerCase().startsWith('detach:')) {
      const seconds = Math.max(1, Number(process.env['BONSAI_FAKE_BACKGROUND_MS'] ?? 4000) / 1000);
      const shell = spawn('sh', ['-c', `sleep ${seconds} &`], {
        cwd: spec.cwd,
        env: { ...process.env, [RUN_MARKER]: spec.runId },
        stdio: 'ignore',
        detached: true,
      });
      shell.on('error', () => undefined);
      shell.unref();
      yield { type: 'tool', name: 'Bash', detail: `nohup sleep ${seconds} &` };
      await abortableDelay(200, spec.signal);
      for (;;) {
        if (spec.signal.aborted || spec.finishNow.aborted) break;
        const detached = await spec.backgroundLeftovers();
        if (detached.length === 0) break;
        spec.onActivity({ state: 'waiting', tool: null, background: detached });
        await abortableDelay(250, spec.signal, spec.finishNow);
      }
      if (spec.signal.aborted) return;
      spec.onActivity({ state: 'working', tool: null, background: [] });
      yield {
        type: 'text',
        text: spec.finishNow.aborted
          ? 'Stopped waiting for the detached process: you chose Finish now.'
          : 'The detached process exited.',
      };
    }

    if (spec.prompt.trimStart().toLowerCase().startsWith('background:')) {
      yield { type: 'tool', name: 'Bash', detail: 'sleep (stand-in background job)' };
      spec.onActivity({
        state: 'waiting',
        tool: null,
        background: [
          {
            id: 'fake-job',
            description: 'Stand-in background job',
            tracked: true,
            startedAt: new Date().toISOString(),
          },
        ],
      });
      await abortableDelay(
        Number(process.env['BONSAI_FAKE_BACKGROUND_MS'] ?? 4000),
        spec.signal,
        spec.finishNow,
      );
      if (spec.signal.aborted) return;
      spec.onActivity({ state: 'working', tool: null, background: [] });
      yield {
        type: 'text',
        text: spec.finishNow.aborted
          ? 'The background job was stopped: you chose Finish now.'
          : 'The background job finished.',
      };
    }

    /**
     * The pause sits BETWEEN the writes, and that placement is the point.
     *
     * Real agents take seconds and write as they go, so being killed leaves the
     * worktree half-finished -- which is the only case recovery exists for
     * (§6.6). A stand-in that returns instantly, or that waits before touching
     * anything, can only ever produce the boring recovery where nothing landed
     * and there is nothing to tell the resumed agent about.
     *
     * Honours the abort signal, so cancellation stays immediate.
     */
    await abortableDelay(Number(process.env['BONSAI_FAKE_DELAY_MS'] ?? 700), spec.signal);

    // A cancelled run stops here rather than finishing. Whatever it already
    // wrote stays on disk for recovery to decide about.
    //
    // It returns silently rather than reporting an error, matching the real
    // runner: a cancellation is not a failure, and saying otherwise made the
    // run row read `failed` with the message "cancelled mid-run".
    if (spec.signal.aborted) return;

    // D28: the agent writes CONTEXT.md as its final action, and the app decides
    // whether it amounts to a commit.
    //
    // The Testing section is written whenever the node has success criteria,
    // mirroring what the real agent is asked to do -- so the stand-in exercises
    // the same shape rather than a simpler one.
    const testing =
      spec.successCriteria === null && spec.verificationHint === null
        ? ''
        : `\n## Testing\n\nRan \`${spec.verificationHint ?? 'the check'}\` — FakeRunner did not really run it.\n` +
          `Success criteria: ${spec.successCriteria ?? '(none given)'}\n`;

    await writeInside(
      spec.cwd,
      'CONTEXT.md',
      `# Context\n\n${spec.prompt.trim()}\n\n${
        question
          ? 'Answered without changing code.'
          : refused === null
            ? 'Changed code.'
            : `Did not change code: ${refused}`
      }\n${testing}`,
    );
    yield { type: 'tool', name: 'Write', detail: 'CONTEXT.md' };

    // D20: cost is captured per run from day one, even when it is fake.
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

/** Waits, unless any of the signals fires first. */
function abortableDelay(ms: number, ...signals: AbortSignal[]): Promise<void> {
  if (ms <= 0 || signals.some((signal) => signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', done);
      resolve();
    }
    for (const signal of signals) signal.addEventListener('abort', done, { once: true });
  });
}

function slug(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s === '' ? 'note' : s;
}

/** Refuses to escape the worktree, which is the isolation boundary. */
async function writeInside(cwd: string, relative: string, content: string): Promise<void> {
  const root = resolve(cwd);
  const target = resolve(join(root, normalize(relative)));
  if (target !== root && !target.startsWith(root + '/')) {
    throw new Error(`refusing to write outside the worktree: ${relative}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
