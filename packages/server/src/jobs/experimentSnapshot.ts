import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeRow, Store } from '../db/store.js';
import { conversationText } from '../domain/conversationText.js';
import { runDiff } from '../git/diff.js';
import { git, status } from '../git/exec.js';

/**
 * Another experiment, written out as files an agent reads when it needs them.
 *
 * Shared by the two places one experiment's work is shown to an agent working
 * elsewhere: an `@experiment` in a message, and a comparison. Both need the
 * same three answers -- what was said, what changed, what it noted -- and both
 * need them fixed at a moment, so an answer never mixes two versions of it.
 *
 * Committed work only. Anything uncommitted in its folder is mentioned, never
 * included: it can change while the reader is reading, and it may be a
 * half-finished run's.
 */
export const EXPERIMENT_FILES = {
  conversation: 'conversation.md',
  changes: 'changes.diff',
  notes: 'CONTEXT.md',
} as const;

export interface ExperimentSnapshot {
  /** Its latest commit when written, or null when it had committed nothing. */
  headCommit: string | null;
  runs: number;
  /**
   * What it changed, for anything that summarises it. Its CONTEXT.md is left
   * out: Bonsai commits notes with every run, and they are shown as notes.
   */
  changedFiles: string[];
  added: number;
  removed: number;
  notes: string | null;
}

/** A transcript is read in pieces, so this only stops a pathological one. */
const CONVERSATION_CAP = 1_000_000;

export async function writeExperimentSnapshot(
  store: Store,
  node: NodeRow,
  folder: string,
  /** File mode; a run's copies are read-only, like its references. */
  mode?: number,
): Promise<ExperimentSnapshot> {
  const project = store.getProject(node.project_id);
  if (project === undefined) throw new Error('no such project');
  const write = (file: string, text: string): Promise<void> =>
    writeFile(join(folder, file), text, mode === undefined ? {} : { flag: 'wx', mode });
  const parent = node.parent_id === null ? undefined : store.getNode(node.parent_id);

  const messages = store.listMessages(node.id, 0);
  const conversation = [`# ${node.display_name}: conversation`, ''];
  if (node.forked_from_message_seq !== null && parent !== undefined) {
    conversation.push(
      `It began from a copy of ${parent.display_name}'s conversation, which is not repeated here.`,
      '',
    );
  }
  conversation.push(
    messages.length === 0
      ? 'It has no conversation of its own yet.'
      : conversationText(messages, null, CONVERSATION_CAP).text,
  );
  await write(EXPERIMENT_FILES.conversation, `${conversation.join('\n')}\n`);

  // Lines starting with # before the first `diff --git` are ignored by git
  // apply, so the header costs the patch nothing.
  const head = node.head_commit;
  const changes: string[] = [];
  let changed = { files: [] as string[], added: 0, removed: 0 };
  if (head === null || node.base_commit === null || head === node.base_commit) {
    changes.push(`# ${node.display_name} has committed no changes of its own.`);
  } else {
    const diff = await runDiff(project.repo_path, node.base_commit, head);
    changed = {
      files: diff.files.filter((file) => file !== NOTES_PATH),
      ...lineCounts(diff.patch, NOTES_PATH),
    };
    changes.push(
      `# ${node.display_name}: everything it committed since it branched, committed work only.`,
      `# ${node.base_commit.slice(0, 7)}..${head.slice(0, 7)}, ${plural(diff.files.length, 'file')}.`,
      '',
      diff.patch,
    );
  }
  const unfinished = await unfinishedCount(node);
  if (unfinished > 0) {
    changes.splice(
      1,
      0,
      `# It also has ${plural(unfinished, 'file')} of unfinished work in its folder, not included.`,
    );
  }
  await write(EXPERIMENT_FILES.changes, `${changes.join('\n')}\n`);

  const notes = head === null ? null : await fileAt(project.repo_path, head, NOTES_PATH);
  await write(
    EXPERIMENT_FILES.notes,
    notes ?? `# ${node.display_name} has no CONTEXT.md notes committed.\n`,
  );

  return {
    headCommit: head,
    runs: store.listRuns(node.id).length,
    changedFiles: changed.files,
    added: changed.added,
    removed: changed.removed,
    notes,
  };
}

/** Where an experiment's notes live: the repository root, whatever its working folder. */
const NOTES_PATH = 'CONTEXT.md';

/** Lines added and removed in a patch, not counting file headers or the skipped file. */
function lineCounts(patch: string, skip: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let skipping = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      skipping = line.endsWith(` b/${skip}`);
      continue;
    }
    if (skipping) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A file as it is in a commit, or null when the commit does not have it. */
async function fileAt(repoPath: string, commit: string, path: string): Promise<string | null> {
  try {
    return await git(['show', `${commit}:${path}`], repoPath);
  } catch {
    return null;
  }
}

/** Uncommitted files in its folder, or 0 when it has none (or no folder yet). */
async function unfinishedCount(node: NodeRow): Promise<number> {
  if (node.worktree_allocated === 0) return 0;
  try {
    return (await status(node.worktree_path)).length;
  } catch {
    return 0;
  }
}

/**
 * Folder names an agent can read at a glance, unique within one run or
 * comparison: `try-redis`, then `try-redis-2`.
 */
export function folderNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'experiment';
    let folder = base;
    for (let n = 2; used.has(folder); n += 1) folder = `${base}-${n}`;
    used.add(folder);
    return folder;
  });
}
