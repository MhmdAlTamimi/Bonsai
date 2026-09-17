import type { ToolDiffLine, ToolResultContent } from '@bonsai/shared';

/**
 * What a tool call produced, from the harness's own structured output.
 *
 * Only two kinds are kept, because only two are worth reading later: a command
 * with its output, and an edit with its changed lines. A Read or a Grep is
 * answered by the file it read; storing that would double the transcript to
 * say nothing.
 *
 * Identified by SHAPE rather than by tool name: `stdout` means a command,
 * `structuredPatch` means a file was changed. The harness has several tools of
 * each kind -- Edit, Write, MultiEdit, NotebookEdit -- and gains more, and a
 * list of names would go quietly out of date while the capture silently
 * stopped working.
 */

/** Output lines kept per command, and changed lines kept per edit. */
export const MAX_OUTPUT_LINES = 12;
export const MAX_EDIT_LINES = 24;
/** Each line is trimmed to this, so one very long line cannot carry a file. */
export const MAX_LINE_CHARS = 400;

export function toolResultFrom(
  toolUseId: string,
  name: string,
  ok: boolean,
  structured: unknown,
  /** The agent's working directory, so an edited file is named as the user names it. */
  root = '',
): ToolResultContent | null {
  const output = structured as Record<string, unknown> | null;
  if (output === null || typeof output !== 'object') return null;

  if (Array.isArray(output['structuredPatch']) && typeof output['filePath'] === 'string') {
    return edited(toolUseId, name, ok, output, root);
  }
  if (typeof output['stdout'] === 'string' || typeof output['stderr'] === 'string') {
    return ran(toolUseId, name, ok, output);
  }
  return null;
}

/** A command: its output, newest information last, trimmed to a readable few lines. */
function ran(
  toolUseId: string,
  name: string,
  ok: boolean,
  output: Record<string, unknown>,
): ToolResultContent {
  const stdout = typeof output['stdout'] === 'string' ? output['stdout'] : '';
  const stderr = typeof output['stderr'] === 'string' ? output['stderr'] : '';
  const lines = [...split(stdout), ...split(stderr)];
  const kept = lines.slice(0, MAX_OUTPUT_LINES).map(clip);
  return {
    toolUseId,
    name,
    ok,
    output: kept,
    ...(lines.length > kept.length ? { dropped: lines.length - kept.length } : {}),
  };
}

/**
 * An edit: the changed lines with their numbers, from the patch the harness
 * already computed. Context lines are kept -- a `+` with nothing around it is
 * not a change anyone can judge -- but only near the changes, which is what a
 * patch hunk already is.
 */
function edited(
  toolUseId: string,
  name: string,
  ok: boolean,
  output: Record<string, unknown>,
  root: string,
): ToolResultContent {
  const lines: ToolDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of output['structuredPatch'] as Array<Record<string, unknown>>) {
    let oldLine = Number(hunk['oldStart'] ?? 0);
    let newLine = Number(hunk['newStart'] ?? 0);
    for (const raw of (hunk['lines'] as string[] | undefined) ?? []) {
      const mark = raw.slice(0, 1);
      const text = clip(raw.slice(1));
      if (mark === '+') {
        added += 1;
        lines.push({ kind: 'add', text, newLine });
        newLine += 1;
      } else if (mark === '-') {
        removed += 1;
        lines.push({ kind: 'del', text, oldLine });
        oldLine += 1;
      } else if (mark === '\\') {
        // "\ No newline at end of file": git's note about the line above.
        continue;
      } else {
        lines.push({ kind: 'context', text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  const stat = output['gitDiff'] as Record<string, unknown> | undefined;
  const kept = lines.slice(0, MAX_EDIT_LINES);
  return {
    toolUseId,
    name,
    ok,
    edit: {
      path: relativeTo(root, String(output['filePath'])),
      added: typeof stat?.['additions'] === 'number' ? stat['additions'] : added,
      removed: typeof stat?.['deletions'] === 'number' ? stat['deletions'] : removed,
      lines: kept,
      ...(lines.length > kept.length ? { truncated: true } : {}),
    },
  };
}

/**
 * The harness reports absolute paths; the user thinks in the paths inside
 * their experiment. Anything outside the working directory keeps its full
 * path, because there the location is the point.
 */
function relativeTo(root: string, path: string): string {
  if (root === '') return path;
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

function split(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .filter((line) => line !== '');
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}
