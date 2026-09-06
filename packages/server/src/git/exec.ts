import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * The only place in Bonsai that shells out to git (D8: the app owns the repo).
 *
 * execFile with an argument array and no shell, so a display name, a path or a
 * commit message can never be interpreted as shell syntax. Nothing here ever
 * builds a command string.
 *
 * Identity is passed per invocation rather than read from the user's global
 * config: the app is the committer, the machine may have no user.email set at
 * all, and D8 says the user never types a git command -- so they should not
 * have to configure one either.
 */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Bonsai',
  GIT_AUTHOR_EMAIL: 'bonsai@localhost',
  GIT_COMMITTER_NAME: 'Bonsai',
  GIT_COMMITTER_EMAIL: 'bonsai@localhost',
  // Keep the app's git deterministic regardless of the user's environment.
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

export async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd,
      env: { ...process.env, ...IDENTITY },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${(e.stderr ?? e.message ?? '').trim()}`,
      args,
      e.stderr ?? '',
    );
  }
}

/** Trimmed single-line output, for the many commands that return one sha or ref. */
export async function gitLine(args: readonly string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).trim();
}

/** One entry from `git status --porcelain -z`. */
export interface StatusEntry {
  /** Two-character XY code. '??' means untracked. */
  code: string;
  path: string;
  untracked: boolean;
}

/**
 * Working-tree status, NUL-separated.
 *
 * D31: plain `git diff` misses untracked files, so a newly created file would
 * be invisible. `status --porcelain` sees them, and -z avoids the path quoting
 * that bites on spaces and non-ASCII names.
 */
export async function status(worktreePath: string): Promise<StatusEntry[]> {
  const raw = await git(['status', '--porcelain', '-z'], worktreePath);
  const parts = raw.split('\0');
  const out: StatusEntry[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record === undefined || record === '') continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // A rename emits the destination in this record and the source in the
    // next one; consume it so it is not read as its own entry.
    if (code.startsWith('R') || code.startsWith('C')) i += 1;
    out.push({ code, path, untracked: code === '??' });
  }
  return out;
}
