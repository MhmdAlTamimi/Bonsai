import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRunner, RunEvent, RunSpec } from './AgentRunner.js';

/**
 * Stands in for the agent so M2 can drive the git layer with fake file writes.
 *
 * The convention is one character, because it has to be usable from the browser
 * without a form for it:
 *
 *   a prompt starting with '?'  ->  writes nothing. Conversation only.
 *   anything else               ->  writes a file, so the node commits.
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

    if (spec.readOnly) {
      yield { type: 'text', text: 'This node is frozen, so I can only read.' };
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return;
    }

    if (!question) {
      const file = `notes/${slug(spec.prompt)}.md`;
      await writeInside(spec.cwd, file, `# ${spec.prompt.trim()}\n\nWritten by FakeRunner.\n`);
      yield { type: 'tool', name: 'Write', detail: file };
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
    if (spec.signal.aborted) {
      yield { type: 'error', error: 'cancelled mid-run' };
      return;
    }

    // D28: the agent writes CONTEXT.md as its final action, and the app decides
    // whether it amounts to a commit.
    await writeInside(
      spec.cwd,
      'CONTEXT.md',
      `# Context\n\n${spec.prompt.trim()}\n\n${question ? 'Answered without changing code.' : 'Changed code.'}\n`,
    );
    yield { type: 'tool', name: 'Write', detail: 'CONTEXT.md' };

    // D20: cost is captured per run from day one, even when it is fake.
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
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
