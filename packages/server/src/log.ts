import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The log.
 *
 * Before this there were seven print statements, so when a run went wrong the
 * entire record of it was one error string in the database. No way to see what
 * the agent was allowed to do, how long it took, or what it tried -- which are
 * the three questions actually asked when something goes wrong.
 *
 * One JSON object per line, one file per day, the last fourteen kept. Node
 * built-ins only: a logging library would be a dependency earning its keep
 * through features (transports, child loggers, pretty printing) that a local
 * single-process app has no use for.
 *
 * WHAT IS NEVER WRITTEN HERE: prompts, file contents, diffs, agent output, and
 * the API key. Lengths and counts instead. A log is the artefact most likely to
 * be pasted into a bug report, and everything in this list is either the user's
 * private code or a credential. `promptChars` answers "was the prompt enormous"
 * without recording a word of it.
 *
 * Writes are synchronous. Async writes would need a queue and a flush on exit,
 * and would lose the last few lines when the process dies -- which is exactly
 * the moment worth having them.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const KEEP_DAYS = 14;
const FILE = /^bonsai-(\d{4}-\d{2}-\d{2})\.log$/;

/** Drops keys whose value is undefined, so a line is not half nulls. */
function compact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

export class FileLogger implements Logger {
  private readonly dir: string;
  /** The day the current file belongs to, so rotation is a date comparison. */
  private day = '';

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'logs');
    mkdirSync(this.dir, { recursive: true });
    this.prune();
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write('error', event, fields);
  }

  /** The most recent lines, newest last. Used by the diagnostics report. */
  tail(lines: number): string[] {
    const files = this.logFiles();
    const out: string[] = [];
    // Walk newest-first and stop as soon as there are enough, so a fortnight of
    // logs is not read to answer a question about the last fifty lines.
    for (let i = files.length - 1; i >= 0 && out.length < lines; i -= 1) {
      let text = '';
      try {
        text = readFileSync(join(this.dir, files[i]!), 'utf8');
      } catch {
        continue;
      }
      const day = text.split('\n').filter((l) => l.trim() !== '');
      out.unshift(...day.slice(Math.max(0, day.length - (lines - out.length))));
    }
    return out;
  }

  directory(): string {
    return this.dir;
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.prune();
    }
    const line = JSON.stringify({ t: now.toISOString(), level, event, ...compact(fields) });
    try {
      appendFileSync(join(this.dir, `bonsai-${day}.log`), line + '\n');
    } catch {
      // A log that cannot be written must not take the app down with it. The
      // console still has it.
      process.stderr.write(`[bonsai] ${line}\n`);
    }
  }

  private logFiles(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((n) => FILE.test(n))
        .sort();
    } catch {
      return [];
    }
  }

  private prune(): void {
    const files = this.logFiles();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
      try {
        unlinkSync(join(this.dir, name));
      } catch {
        // Another process holding it, or already gone. Neither is worth failing.
      }
    }
  }
}

/** Discards everything. Used by tests, which have no data directory. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
