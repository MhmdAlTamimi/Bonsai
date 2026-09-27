import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    /** The process exit code, when git ran and exited non-zero. */
    readonly exitCode: number | null = null,
    readonly stdout = '',
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

export async function git(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd,
      env: { ...process.env, ...IDENTITY, ...env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: unknown };
    throw new GitError(
      `git ${args.join(' ')} failed: ${(e.stderr ?? e.message ?? '').trim()}`,
      args,
      e.stderr ?? '',
      typeof e.code === 'number' ? e.code : null,
      e.stdout ?? '',
    );
  }
}

/**
 * For `git diff --no-index`, which exits 1 when the two sides differ -- the
 * only case anyone runs it for. Exit 1 is output, not failure.
 */
export async function gitDiffNoIndex(args: readonly string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return err.stdout;
    throw err;
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
  /** Where a renamed or copied path came from. */
  oldPath?: string;
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
  const raw = await git(['status', '--porcelain', '-z', '--untracked-files=all'], worktreePath);
  const parts = raw.split('\0');
  const out: StatusEntry[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record === undefined || record === '') continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // A rename emits the destination in this record and the source in the
    // next one; consume it so it is not read as its own entry.
    if (code.startsWith('R') || code.startsWith('C')) {
      i += 1;
      out.push({ code, path, oldPath: parts[i] ?? '', untracked: false });
      continue;
    }
    out.push({ code, path, untracked: code === '??' });
  }
  return out;
}

/**
 * Gitignored paths in a checkout, as git lists them: a directory that is
 * ignored as a whole appears once, with a trailing slash, rather than file by
 * file -- which keeps a node_modules to one line.
 */
export async function ignoredPaths(worktreePath: string): Promise<string[]> {
  const raw = await git(['status', '--porcelain', '-z', '--ignored'], worktreePath);
  return raw
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3));
}

/** Drain Git output with bounded memory. Truncation is explicit; errors still propagate. */
export async function gitPatch(
  args: readonly string[],
  cwd: string,
  limit = 2 * 1024 * 1024,
): Promise<{ patch: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: { ...process.env, ...IDENTITY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const keep = Math.max(0, limit - bytes);
      if (chunk.length > keep) truncated = true;
      if (keep > 0) {
        const part = chunk.subarray(0, keep);
        chunks.push(part);
        bytes += part.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !(code === 1 && args.includes('--no-index'))) {
        reject(new GitError(`Git patch failed: ${stderr}`, args, stderr, code));
        return;
      }
      let patch = Buffer.concat(chunks).toString('utf8');
      if (truncated) patch = patch.slice(0, Math.max(0, patch.lastIndexOf('\n') + 1));
      resolve({ patch, truncated });
    });
  });
}
