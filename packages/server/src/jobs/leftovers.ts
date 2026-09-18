import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The environment variable every agent process carries: the id of the run that
 * started it (D43).
 *
 * The harness tracks what the agent starts in its background mode, but not a
 * process detached with `nohup … &`, `setsid` or `disown` -- which is exactly
 * how the incident's experiment was started. Such a process inherits the
 * agent's environment, so the marker survives the detaching, and it is how
 * Bonsai finds work that would otherwise outlive a run nobody knew was
 * still producing files.
 */
export const RUN_MARKER = 'BONSAI_RUN_ID';

export interface MarkedProcess {
  pid: number;
  ppid: number;
  /** The command line, for telling the user what is still running. */
  command: string;
}

/**
 * Processes started by this run that have left the agent's process tree.
 *
 * Every process the agent starts carries the marker, including the harness
 * itself and the jobs it tracks, and those still descend from this server.
 * A detached process does not: its parent shell exits and it is re-parented
 * elsewhere. So "carries this run's marker, and is not our descendant" is
 * precisely "started by this run, and invisible to the harness".
 *
 * Linux reads /proc, macOS asks `ps`. Windows is not covered and returns
 * nothing -- a documented limit, not a silent one.
 */
export async function findLeftovers(
  runId: string,
  self: number = process.pid,
): Promise<MarkedProcess[]> {
  const table =
    process.platform === 'linux'
      ? linuxProcesses(runId)
      : process.platform === 'darwin'
        ? await macProcesses(runId)
        : null;
  if (table === null) return [];

  const parents = new Map(table.all.map(([pid, ppid]) => [pid, ppid]));
  const descends = (pid: number): boolean => {
    // Bounded: a pid table read in pieces can briefly contain a cycle.
    for (let current = pid, hops = 0; hops < 128; hops += 1) {
      if (current === self) return true;
      const parent = parents.get(current);
      if (parent === undefined || parent <= 1) return false;
      current = parent;
    }
    return false;
  };
  return table.marked.filter((p) => p.pid !== self && !descends(p.pid));
}

/**
 * The processes worth naming: those whose parent is not itself a leftover. A
 * detached `uv run python train.py` is two processes and one piece of work.
 */
export function roots(processes: readonly MarkedProcess[]): MarkedProcess[] {
  const pids = new Set(processes.map((p) => p.pid));
  return processes.filter((p) => !pids.has(p.ppid));
}

/**
 * Ends this run's leftovers: SIGTERM, a grace period, then SIGKILL for any
 * that are still there. Re-found by marker before the second signal rather
 * than trusted by pid, so a pid reused in between is never killed.
 *
 * Returns what was running when it was called, one entry per piece of work.
 */
export async function stopLeftovers(runId: string, graceMs = 3_000): Promise<MarkedProcess[]> {
  const found = await findLeftovers(runId);
  if (found.length === 0) return [];
  for (const p of found) signal(p.pid, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  let remaining = found;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    remaining = await findLeftovers(runId);
  }
  for (const p of remaining) signal(p.pid, 'SIGKILL');
  return roots(found);
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone, which is the outcome being asked for.
  }
}

interface ProcessTable {
  /** Every visible process, as [pid, ppid], for walking ancestry. */
  all: Array<[number, number]>;
  marked: MarkedProcess[];
}

/**
 * Synchronous on purpose. A scan is two small reads per process, and done
 * through the thread pool it took about five times as long (40ms against 8ms
 * for ~400 processes) while holding up other file work queued behind it. It
 * runs when a turn ends and every few seconds while a run waits on detached
 * work, never on a request path.
 */
function linuxProcesses(runId: string): ProcessTable {
  const wanted = `\0${RUN_MARKER}=${runId}\0`;
  const all: Array<[number, number]> = [];
  const marked: MarkedProcess[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return { all, marked };
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    // Any read can fail: the process may exit mid-scan, and another user's
    // environment is not readable. Neither is ours to report.
    const stat = readQuietly(`/proc/${name}/stat`);
    if (stat === null) continue;
    // The command name is in parentheses and may itself contain spaces or
    // parentheses, so fields are counted from the LAST closing one.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isFinite(ppid)) continue;
    const pid = Number(name);
    all.push([pid, ppid]);

    const environ = readQuietly(`/proc/${name}/environ`);
    if (environ === null || !`\0${environ}`.includes(wanted)) continue;
    const cmdline = readQuietly(`/proc/${name}/cmdline`) ?? '';
    marked.push({ pid, ppid, command: cmdline.split('\0').filter(Boolean).join(' ') });
  }
  return { all, marked };
}

function readQuietly(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function macProcesses(runId: string): Promise<ProcessTable> {
  const marker = new RegExp(`(^|\\s)${RUN_MARKER}=${runId.replace(/[^\w-]/g, '')}(\\s|$)`);
  // Two listings: `-E` appends each process's environment to its command,
  // with nothing to say where one ends and the other begins, so the command
  // shown to the user comes from the listing without it.
  const [withEnv, plain] = await Promise.all([
    exec('ps', ['-A', '-E', '-ww', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 }),
    exec('ps', ['-A', '-ww', '-o', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 }),
  ]).catch(() => [{ stdout: '' }, { stdout: '' }]);

  const commands = new Map<number, string>();
  for (const line of plain.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  const all: Array<[number, number]> = [];
  const marked: MarkedProcess[] = [];
  for (const line of withEnv.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    all.push([pid, ppid]);
    if (marker.test(match[3]!)) marked.push({ pid, ppid, command: commands.get(pid) ?? '' });
  }
  return { all, marked };
}
