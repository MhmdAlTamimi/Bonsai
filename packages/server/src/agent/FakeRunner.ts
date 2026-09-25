import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentQuestion, ToolResultContent } from '@bonsai/shared';
import type {
  AgentRunner,
  ConversationCopier,
  DraftRequest,
  RunEvent,
  RunSpec,
  TextDrafter,
} from './AgentRunner.js';
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
 * waits for either (D43). "tools:" makes the three kinds of tool block — a
 * read, a search and a command with more output than a block shows.
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
/** What the stand-in "ran": a few lines of output, the way a real command answers. */
function ranOutput(id: string, command: string, lines: string[]): ToolResultContent {
  return { toolUseId: id, name: 'Bash', ok: true, output: lines };
}

/** What the stand-in wrote, as the changed lines an EDIT block draws. */
function wroteFile(id: string, path: string, body: string): ToolResultContent {
  const lines = body.split('\n').filter((line) => line !== '');
  return {
    toolUseId: id,
    name: 'Write',
    ok: true,
    edit: {
      path,
      added: lines.length,
      removed: 0,
      lines: lines.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
    },
  };
}

export class FakeRunner implements AgentRunner, ConversationCopier, TextDrafter {
  /**
   * A draft that shows what it was written from: the request, then the last
   * lines of the conversation. Good enough to see the editor fill in.
   */
  draft(request: DraftRequest): Promise<string> {
    const asked = /## What to write\n\n([^\n]+)/.exec(request.input)?.[1] ?? 'a reference';
    const said = request.input
      .split('\n')
      .filter((line) => line.startsWith('Agent: ') || line.startsWith('User: '))
      .slice(-3);
    return Promise.resolve(
      [`Stand-in draft: ${asked}`, '', ...said.map((l) => `- ${l}`)].join('\n'),
    );
  }

  /** A copy is just a new id here: the stand-in keeps no transcripts to copy. */
  forkConversation(): Promise<string> {
    return Promise.resolve(`fake-${randomUUID()}`);
  }

  /**
   * The stand-in's /compact: says it is compacting for long enough to see,
   * then reports made-up numbers the way the harness reports real ones.
   */
  private async *command(spec: RunSpec): AsyncIterable<RunEvent> {
    if (!spec.prompt.startsWith('/compact')) {
      yield { type: 'notice', text: `${spec.prompt.split(/\s/)[0]} is not available here.` };
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return;
    }
    spec.onActivity({ state: 'compacting', tool: null, background: [] });
    await abortableDelay(Number(process.env['BONSAI_FAKE_DELAY_MS'] ?? 700), spec.signal);
    if (spec.signal.aborted) return;
    spec.onActivity({ state: 'working', tool: null, background: [] });
    yield { type: 'compacted', trigger: 'manual', tokensBefore: 48_200, tokensAfter: 6_100 };
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    // Mirrors the real runner: a resume keeps the session it was given, and a
    // node with none yet gets a new one.
    yield { type: 'session', sessionId: spec.resumeSessionId ?? `fake-${randomUUID()}` };
    if (spec.isCommand === true) {
      yield* this.command(spec);
      return;
    }

    const question = spec.prompt.trimStart().startsWith('?');
    yield {
      type: 'text',
      text: question
        ? `Reading the code to answer: ${spec.prompt.trim()}`
        : `Working on: ${spec.prompt.trim()}`,
    };
    yield { type: 'position', messageId: randomUUID() };
    // Reads what it was given, the way a real agent does -- a Read of each file.
    for (const reference of spec.references ?? []) {
      yield { type: 'tool', name: 'Read', detail: reference.path, id: randomUUID() };
    }

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

    /**
     * The three kinds of block, for looking at the conversation itself: a
     * READ with nothing to show, another read of a different shape, and a RUN
     * whose output is longer than the eight lines a block draws.
     */
    if (spec.prompt.trimStart().toLowerCase().startsWith('tools:')) {
      yield {
        type: 'tool',
        name: 'Read',
        detail: `${spec.cwd}/chunking_experiment/run_experiment.py`,
        id: 'fake-read',
      };
      yield { type: 'tool', name: 'Grep', detail: 'sheet_header', id: 'fake-grep' };
      yield {
        type: 'tool',
        name: 'Bash',
        detail: 'python run_experiment.py --bucket kb-raw',
        id: 'fake-run',
      };
      yield {
        type: 'tool_result',
        result: ranOutput(
          'fake-run',
          'python',
          Array.from({ length: 20 }, (_, i) => `processed document ${i + 1}`),
        ),
      };
      yield { type: 'text', text: 'Ran the extractor over the bucket.' };
    }

    if (!question && refused === null) {
      const file = `notes/${slug(spec.prompt)}.md`;
      const body = `# ${spec.prompt.trim()}\n\nWritten by FakeRunner.\n`;
      await writeInside(spec.cwd, file, body);
      yield { type: 'tool', name: 'Write', detail: file, id: 'fake-write' };
      yield { type: 'tool_result', result: wroteFile('fake-write', file, body) };
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
      yield { type: 'tool', name: 'Bash', detail: `nohup sleep ${seconds} &`, id: 'fake-detach' };
      yield {
        type: 'tool_result',
        result: ranOutput('fake-detach', 'nohup', [`started a detached sleep ${seconds}`]),
      };
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
      yield {
        type: 'tool',
        name: 'Bash',
        detail: 'sleep (stand-in background job)',
        id: 'fake-background',
      };
      yield {
        type: 'tool_result',
        result: ranOutput('fake-background', 'sleep', [
          'running in the background',
          'stand-in job · no real work',
        ]),
      };
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

    const context =
      `# Context\n\n${spec.prompt.trim()}\n\n${
        question
          ? 'Answered without changing code.'
          : refused === null
            ? 'Changed code.'
            : `Did not change code: ${refused}`
      }\n` + testing;
    await writeInside(
      spec.contextPath === undefined ? spec.cwd : dirname(spec.contextPath),
      'CONTEXT.md',
      context,
    );
    yield { type: 'tool', name: 'Write', detail: 'CONTEXT.md', id: 'fake-context' };
    yield { type: 'tool_result', result: wroteFile('fake-context', 'CONTEXT.md', context) };

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

/** Refuses to escape the worktree, for deterministic test writes. */
async function writeInside(cwd: string, relative: string, content: string): Promise<void> {
  const root = resolve(cwd);
  const target = resolve(join(root, normalize(relative)));
  if (target !== root && !target.startsWith(root + '/')) {
    throw new Error(`refusing to write outside the worktree: ${relative}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
