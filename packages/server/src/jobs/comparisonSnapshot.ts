import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExperimentFacts } from '@bonsai/shared';

import type { ComparedExperimentInput, NodeRow, Store } from '../db/store.js';
import { testingSection } from '../git/context.js';
import { EXPERIMENT_FILES, writeExperimentSnapshot } from './experimentSnapshot.js';

/**
 * What a comparison reads: one folder per experiment, fixed at a moment.
 *
 * Each holds the three files an `@experiment` gets (conversation, committed
 * changes, notes), a short `experiment.md` with the facts its card shows, and
 * `files/` -- its whole repository at the compared commit -- so a question like
 * "how does each one handle eviction?" can be answered in context rather than
 * from the diff alone. The agent is given read tools and nothing else, so none
 * of this can be changed from the comparison.
 */
export const FACTS_FILE = 'experiment.md';
export const FILES_FOLDER = 'files';

export function comparisonFolder(store: Store, projectId: string, comparisonId: string): string {
  return join(store.projectScratchDir(projectId), 'compare', comparisonId);
}

/** Writes one experiment's folder afresh and returns what to record about it. */
export async function snapshotForComparison(
  store: Store,
  node: NodeRow,
  root: string,
  folder: string,
): Promise<ComparedExperimentInput> {
  const project = store.getProject(node.project_id);
  if (project === undefined) throw new Error('no such project');
  const path = join(root, folder);
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });

  const snapshot = await writeExperimentSnapshot(store, node, path);
  const facts: ExperimentFacts = {
    status: node.status,
    successCriteria: node.success_criteria,
    testing: testingSection(snapshot.notes),
    approach: approachOf(snapshot.notes),
    files: snapshot.changedFiles,
    added: snapshot.added,
    removed: snapshot.removed,
    runs: snapshot.runs,
    costUsd: store.nodeCost(node.id),
  };

  const commit = snapshot.headCommit ?? node.base_commit;
  let files = 'not available';
  if (commit !== null) {
    try {
      await exportTree(project.repo_path, commit, join(path, FILES_FOLDER));
      files = `${FILES_FOLDER}/ holds its whole repository at ${commit.slice(0, 7)}`;
    } catch (error) {
      files = `could not be exported (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  await writeFile(join(path, FACTS_FILE), factsText(node.display_name, facts, files));
  return { nodeId: node.id, name: node.display_name, folder, runs: snapshot.runs, facts };
}

/** The index at the top of the comparison folder: what is here and what each file is. */
export async function writeComparisonIndex(
  root: string,
  experiments: ReadonlyArray<{ name: string; folder: string }>,
): Promise<void> {
  await writeFile(
    join(root, 'README.md'),
    [
      `# Comparing ${experiments.map((e) => e.name).join(', ')}`,
      '',
      "Each folder is a snapshot of one experiment's committed work:",
      '',
      ...experiments.map((e) => `- ${e.folder}/ is ${e.name}`),
      '',
      'In each folder:',
      `- ${FACTS_FILE}: its goal, status, runs, cost and what it recorded as tested`,
      `- ${EXPERIMENT_FILES.conversation}: its own conversation`,
      `- ${EXPERIMENT_FILES.changes}: everything it committed, as a diff`,
      `- ${EXPERIMENT_FILES.notes}: its notes`,
      `- ${FILES_FOLDER}/: its whole repository at the compared commit`,
      '',
    ].join('\n'),
  );
}

/**
 * How it went about it, in a few lines: the opening of its notes, leaving out
 * headings, its testing section, and Bonsai's own placeholder line.
 */
export function approachOf(notes: string | null): string | null {
  if (notes === null) return null;
  const testing = testingSection(notes);
  const body = (testing === null ? notes : notes.replace(testing, ''))
    .split('\n')
    .filter((line) => !line.startsWith('#') && !/^_.*_$/.test(line.trim()));
  const paragraph = body
    .join('\n')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (paragraph === undefined) return null;
  const flat = paragraph.replace(/\s+/g, ' ');
  return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
}

function factsText(name: string, facts: ExperimentFacts, files: string): string {
  return [
    `# ${name}`,
    '',
    `- Status: ${facts.status}`,
    `- Success looks like: ${facts.successCriteria ?? 'not stated'}`,
    `- Runs: ${facts.runs}, estimated cost $${facts.costUsd.toFixed(2)}`,
    `- Committed changes: ${facts.files.length} files, +${facts.added} -${facts.removed}`,
    `- Files: ${files}`,
    '',
    '## What it recorded as tested',
    '',
    facts.testing ?? 'Nothing recorded.',
    '',
  ].join('\n');
}

/**
 * A commit's files, as plain files in a folder: `git archive` piped into
 * `tar`, which every platform Bonsai runs on has. Plain files rather than a
 * checkout, so nothing is registered in the repository and nothing needs
 * cleaning up there afterwards.
 */
function exportTree(repoPath: string, commit: string, into: string): Promise<void> {
  return mkdir(into, { recursive: true }).then(
    () =>
      new Promise<void>((resolve, reject) => {
        const archive = spawn('git', ['archive', '--format=tar', commit], {
          cwd: repoPath,
          windowsHide: true,
        });
        const extract = spawn('tar', ['-xf', '-', '-C', into], { windowsHide: true });
        let failed = false;
        const fail = (error: Error): void => {
          if (failed) return;
          failed = true;
          archive.kill();
          extract.kill();
          reject(error);
        };
        archive.on('error', fail);
        extract.on('error', fail);
        archive.stdout.pipe(extract.stdin);
        archive.on('close', (code) => {
          if (code !== 0) fail(new Error(`git archive exited with ${code}`));
        });
        extract.on('close', (code) => {
          if (code !== 0) fail(new Error(`tar exited with ${code}`));
          else if (!failed) resolve();
        });
      }),
  );
}
