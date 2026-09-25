import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ResolvedRunContext, RunExperimentView, RunReferenceView } from '@bonsai/shared';

import type { NodeRow, ReferenceRow, Store } from '../db/store.js';
import { revisionOf } from '../db/referenceStore.js';
import { folderNames, writeExperimentSnapshot } from './experimentSnapshot.js';

/** A reference as the agent receives it: a name and a file to read. */
export interface ReferenceFile {
  name: string;
  path: string;
}

/** Another experiment as the agent receives it: a name and a folder of its files. */
export interface ExperimentFolder {
  name: string;
  path: string;
}

/** What a run was handed alongside its message, and where it all is. */
export interface RunAttachments {
  context: ResolvedRunContext;
  references: ReferenceFile[];
  experiments: ExperimentFolder[];
  /** The run's own folder, holding both; null when nothing was attached. */
  folder: string | null;
  /** Attached, then deleted before the run started. */
  missing: { references: number; experiments: number };
}

/**
 * What a run is given, fixed and recorded when it starts executing.
 *
 * Everything is read before anything is awaited, so what the user changes
 * after pressing send -- a new goal, an edited reference -- belongs to the next
 * run rather than leaking into this one.
 *
 * The conversation is deliberately absent. The node resumes its own session,
 * which for a child is a copy of its parent's taken at creation; handing it a
 * fresher transcript of the parent here would describe code the child's
 * checkout does not have.
 *
 * References and experiments attached to the message are written as
 * read-only files in this run's own folder and the agent is told where they
 * are, rather than their text being pasted into the prompt: the agent reads
 * what it needs, and each run keeps the exact version it was given even after
 * the reference is edited or the experiment moves on.
 */
export async function resolveRunContext(
  store: Store,
  node: NodeRow,
  runId: string,
  attach: { referenceIds?: readonly string[]; experimentIds?: readonly string[] } = {},
): Promise<RunAttachments> {
  const referenceIds = attach.referenceIds ?? [];
  const experimentIds = attach.experimentIds ?? [];
  const parent = node.parent_id === null ? undefined : store.getNode(node.parent_id);
  const rows = referenceIds.map((id) => store.references.get(id));
  const attached = rows.filter((row): row is ReferenceRow => row !== undefined);
  const others = experimentIds
    .map((id) => store.getNode(id))
    .filter((row): row is NodeRow => row?.project_id === node.project_id);
  const folders = folderNames(others.map((row) => row.display_name));
  const files = fileNames(attached.map((row) => row.name));
  const references: RunReferenceView[] = attached.map((row, index) => ({
    id: row.id,
    name: row.name,
    revision: revisionOf(row.content),
    size: row.content.length,
    file: files[index]!,
  }));
  const context: ResolvedRunContext = {
    resolvedAt: new Date().toISOString(),
    successCriteria: node.success_criteria,
    verificationHint: node.verification_hint,
    codeCommit: node.head_commit ?? node.base_commit,
    parentNodeId: parent?.id ?? null,
    parentName: parent?.display_name ?? null,
    parentHeadCommit: parent?.head_commit ?? null,
    ...(references.length === 0 ? {} : { references }),
  };
  // Recorded before anything is awaited; the experiments' snapshot points are
  // added once they are written, which is what fixes them.
  store.recordRunContext(runId, context);

  const folder = runFolder(store, node.project_id, runId);
  const written: ReferenceFile[] = [];
  if (attached.length > 0) await mkdir(join(folder, 'references'), { recursive: true });
  for (const [index, row] of attached.entries()) {
    const path = join(folder, 'references', files[index]!);
    await writeFile(path, row.content, { flag: 'wx', mode: 0o400 });
    written.push({ name: row.name, path });
  }

  const experiments: ExperimentFolder[] = [];
  const views: RunExperimentView[] = [];
  for (const [index, other] of others.entries()) {
    const path = join(folder, 'experiments', folders[index]!);
    await mkdir(path, { recursive: true });
    const snapshot = await writeExperimentSnapshot(store, other, path, 0o400);
    experiments.push({ name: other.display_name, path });
    views.push({ id: other.id, name: other.display_name, folder: folders[index]!, ...snapshot });
  }
  if (views.length > 0) {
    context.experiments = views;
    store.recordRunContext(runId, context);
  }

  return {
    context,
    references: written,
    experiments,
    folder: written.length + experiments.length === 0 ? null : folder,
    // Deleted between pressing send and the run starting: said, not skipped silently.
    missing: {
      references: referenceIds.length - attached.length,
      experiments: experimentIds.length - others.length,
    },
  };
}

/** The exact text a run was given for one of its references. */
export async function readRunReference(
  store: Store,
  projectId: string,
  runId: string,
  reference: RunReferenceView,
): Promise<string> {
  // The recorded name is a bare file name; anything else is not ours to read.
  if (basename(reference.file) !== reference.file) throw new Error('not a reference snapshot');
  return readFile(join(runFolder(store, projectId, runId), 'references', reference.file), 'utf8');
}

function runFolder(store: Store, projectId: string, runId: string): string {
  return join(store.projectScratchDir(projectId), 'run-context', runId);
}

/**
 * File names an agent can read at a glance: the reference's name, made safe,
 * made unique within the run. `smoke-test.md`, not an id.
 */
export function fileNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'reference';
    let file = `${base}.md`;
    for (let n = 2; used.has(file); n += 1) file = `${base}-${n}.md`;
    used.add(file);
    return file;
  });
}
