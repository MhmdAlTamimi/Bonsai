import { spawn } from 'node:child_process';

/**
 * Running a project's own commands, in a node's worktree.
 *
 * Used twice: once at node creation, to run the project's setup command before
 * the agent starts, and later on demand from the panel. The two are the same
 * machinery with different callers, so this is the shared piece rather than
 * two implementations that drift.
 *
 * A SHELL IS USED HERE, unlike everywhere else in this codebase.
 *
 * git/exec.ts goes out of its way to avoid one, because it builds argument
 * arrays out of display names and paths and a shell would turn those into
 * syntax. This is the opposite case: the value IS a command line, typed by the
 * user, and `npm install && npm run build` or `uv sync` are exactly what they
 * mean. Splitting it on spaces would break every command with a quoted
 * argument, a pipe or an `&&`. The user is running commands on their own
 * machine in their own project; the shell is the feature.
 *
 * What is not the user's own is what a command PRINTS. Output is truncated and
 * handed back as text, never interpreted.
 */

export interface CommandResult {
  command: string;
  cwd: string;
  /** Null when the process was killed by a signal or never started. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the timeout killed it, which exitCode alone cannot say. */
  timedOut: boolean;
  /** True when it exited 0. The one thing callers usually want. */
  ok: boolean;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  /** Default fifteen minutes: `npm install` on a cold cache is not fast. */
  timeoutMs?: number;
  /** Extra environment. The agent's credential is never among it. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Called with each chunk, so a long install can be watched rather than waited on. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Kept per stream. Enough to diagnose a failure, small enough to store. */
const MAX_OUTPUT = 64 * 1024;

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const { command, cwd } = options;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...options.env, CI: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      options.onOutput?.(text, stream);
      // Keeping the TAIL rather than the head: when a build fails, the error is
      // at the end, and a head-truncated log is the half nobody needs.
      if (stream === 'stdout') stdout = tail(stdout + text);
      else stderr = tail(stderr + text);
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so a build can clean up; SIGKILL if it will not go.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        cwd,
        exitCode,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        ok: exitCode === 0,
      });
    };

    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      // A command that could not start at all -- no such shell, no such cwd.
      // Reported as a failure with the reason rather than thrown, because
      // every caller has to handle a non-zero exit anyway.
      stderr = tail(stderr + String(err));
      finish(null, null);
    });
  });
}

function tail(text: string): string {
  return text.length <= MAX_OUTPUT ? text : text.slice(text.length - MAX_OUTPUT);
}

/** One line saying how it went, for a log or a chat message. */
export function summarise(result: CommandResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.timedOut) return `\`${result.command}\` timed out after ${seconds}s`;
  if (result.ok) return `\`${result.command}\` succeeded in ${seconds}s`;
  return `\`${result.command}\` exited ${result.exitCode ?? result.signal ?? 'abnormally'} after ${seconds}s`;
}
