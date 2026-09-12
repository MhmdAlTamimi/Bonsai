import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_FILE } from './commit.js';

/** D22: CONTEXT.md is a human-readable record shown in the panel, not memory. */
export async function readContextFile(worktreePath: string): Promise<string | null> {
  try {
    return await readFile(join(worktreePath, CONTEXT_FILE), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The `## Testing` section of a CONTEXT.md, on its own.
 *
 * The agent is asked to write one whenever the node has success criteria, and
 * it is the answer to the question this whole feature exists for -- so the
 * panel shows it directly instead of leaving it halfway down a file behind a
 * disclosure.
 *
 * Deliberately forgiving about the heading. The agent writes prose, not a data
 * format: it may say "## Testing", "## Verification" or "### Testing", and
 * failing to find any of those would silently turn the feature back off.
 */
export function testingSection(contextMd: string | null): string | null {
  if (contextMd === null) return null;

  const lines = contextMd.split('\n');
  const start = lines.findIndex((line) => /^#{2,4}\s*(testing|verification|checks?)\b/i.test(line));
  if (start === -1) return null;

  // Runs to the next heading of the same level or shallower, or to the end.
  const level = (/^#+/.exec(lines[start]!) ?? ['##'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#+)\s/.exec(lines[i]!);
    if (heading !== null && heading[1]!.length <= level) {
      end = i;
      break;
    }
  }

  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  return body === '' ? null : body;
}
