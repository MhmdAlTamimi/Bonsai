import type { BackgroundJob, RunActivity } from '@bonsai/shared';

/**
 * Words for what a run is doing (D43), kept out of the component so they can
 * be tested: "Running uv sync · 1m 12s" is the whole difference between a long
 * command that looks stuck and one that looks like work.
 */

/** A verb for a tool, so the strip reads as a sentence rather than an API name. */
export function describeTool(tool: NonNullable<RunActivity['tool']>): string {
  const detail = tool.detail.trim();
  const verb =
    {
      Bash: 'Running',
      Read: 'Reading',
      Edit: 'Editing',
      MultiEdit: 'Editing',
      Write: 'Writing',
      NotebookEdit: 'Editing',
      Grep: 'Searching for',
      Glob: 'Looking for',
      WebFetch: 'Fetching',
      WebSearch: 'Searching the web for',
      Task: 'Delegating',
      Agent: 'Delegating',
      Setup: 'Setting up',
    }[tool.name] ?? `Using ${tool.name}`;
  return detail === '' ? verb : `${verb} ${detail}`;
}

/** Elapsed time, compact: 8s, 4m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function since(iso: string, now: number): string {
  const started = Date.parse(iso);
  return Number.isNaN(started) ? '' : formatElapsed(now - started);
}

/** "Waiting for 1 background job", or for several. */
export function waitingHeadline(jobs: readonly BackgroundJob[]): string {
  if (jobs.length === 0) return 'Waiting for background work to finish';
  return `Waiting for ${jobs.length === 1 ? '1 background job' : `${jobs.length} background jobs`}`;
}
