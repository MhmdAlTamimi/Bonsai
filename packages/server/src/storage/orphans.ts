import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { basename, join, dirname } from 'node:path';
import type { LostExperimentView } from '@bonsai/shared';
import type { Store } from '../db/store.js';
import { git, gitLine } from '../git/exec.js';
import { nodeRef, pinRef, projectRefs } from '../git/refs.js';
import { readGitState } from '../git/ownership.js';
import { copyWorkingFiles, exportExperiment, protectExportTips } from '../git/export.js';
import { indexTrees, workingTreeSnapshot } from '../git/snapshot.js';
import { samePath } from '../paths.js';
import { OperationConflict } from '../domain/errors.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function lostExperiments(
  store: Store,
  projectId: string,
): Promise<LostExperimentView[]> {
  const project = store.getProject(projectId);
  if (!project) throw new OperationConflict('No such project.');
  const known = new Set(store.listNodes(projectId).map((node) => node.id));
  const found = new Map<string, { commit: string; folder: string | null; ref: string }>();
  for (const [ref, commit] of await projectRefs(project.repo_path, projectId)) {
    const suffix = ref.slice(`refs/bonsai/${projectId}/`.length);
    if (
      known.has(suffix) ||
      store.saves.pending().some((save) => ref.endsWith(`/saves/${save.runId}`))
    )
      continue;
    const recovered = store.metadata(`recovered:${ref}`);
    if (recovered !== null && store.getNode(recovered)) continue;
    found.set(suffix, { ref, commit, folder: null });
  }
  const scratch = store.projectScratchDir(projectId);
  const records = (await git(['worktree', 'list', '--porcelain', '-z'], project.repo_path)).split(
    '\0\0',
  );
  for (const record of records) {
    const fields = record.split('\0');
    const folder = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    const commit = fields.find((field) => field.startsWith('HEAD '))?.slice(5);
    if (
      !folder ||
      !commit ||
      !samePath(dirname(folder), join(scratch, 'worktrees')) ||
      !uuid.test(basename(folder)) ||
      known.has(basename(folder))
    )
      continue;
    const id = basename(folder);
    const prior = found.get(id);
    found.set(id, {
      ref: nodeRef(projectId, id),
      commit: prior?.commit ?? commit,
      folder: existsSync(folder) ? folder : null,
    });
  }
  return Promise.all(
    [...found].map(async ([id, item]) => ({
      id,
      ...item,
      subject: await gitLine(['log', '-1', '--format=%s', item.commit], project.repo_path),
      version: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
    })),
  );
}

/** Recover metadata only after preserving all versions; never reset the orphan's files. */
export async function importLostExperiment(
  store: Store,
  projectId: string,
  id: string,
  version: string,
  preservationRoot: string,
): Promise<{ nodeId: string; preservedPath: string }> {
  const project = store.getProject(projectId)!;
  if (store.deletions.pending().some((intent) => intent.project.id === projectId))
    throw new OperationConflict('Finish or cancel deletion first.');
  const item = (await lostExperiments(store, projectId)).find((item) => item.id === id);
  if (item?.version !== version)
    throw new OperationConflict('The saved experiment changed. Refresh the recovery list.');
  const parent = store.listNodes(projectId).find((node) => node.parent_id === null)!;
  const nodeId = uuid.test(id) ? id : randomUUID();
  if (store.getNode(nodeId)) throw new OperationConflict('This experiment is already recorded.');
  const actual = item.folder === null ? null : await readGitState(item.folder);
  const workingTree = item.folder === null ? null : await workingTreeSnapshot(item.folder);
  const staged = item.folder === null ? {} : await indexTrees(item.folder);
  const stagedTips: Record<string, string> = {};
  for (const [name, tree] of Object.entries(staged))
    stagedTips[name] = await gitLine(
      ['commit-tree', tree, '-p', actual!.head, '-m', `Preserve recovered ${name} content`],
      project.repo_path,
    );
  if (
    actual !== null &&
    !samePath(
      actual.commonDir,
      await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], project.repo_path),
    )
  )
    throw new OperationConflict('The folder belongs to another repository and was preserved.');
  const preservedPath = await exportExperiment(
    project.repo_path,
    item.commit,
    preservationRoot,
    'recovered-experiment',
  );
  await protectExportTips(preservedPath, project.repo_path, {
    saved: item.commit,
    folder: actual?.head ?? null,
    ...stagedTips,
  });
  if (item.folder !== null) await copyWorkingFiles(item.folder, preservedPath);
  const current = (await lostExperiments(store, projectId)).find((found) => found.id === id);
  if (
    current?.version !== version ||
    (actual !== null &&
      (JSON.stringify(await readGitState(item.folder!)) !== JSON.stringify(actual) ||
        (await workingTreeSnapshot(item.folder!)) !== workingTree ||
        JSON.stringify(await indexTrees(item.folder!)) !== JSON.stringify(staged)))
  )
    throw new OperationConflict(
      `The experiment changed while being preserved. Copy kept at ${preservedPath}; refresh and retry.`,
    );
  if ((await pinRef(project.repo_path, nodeRef(projectId, nodeId), item.commit)) !== item.commit)
    throw new OperationConflict('The recovered ref changed. Files were preserved.');
  const node = store.recordRecoveredExperiment(
    {
      id: nodeId,
      projectId,
      parentId: parent.id,
      displayName: `Recovered ${item.subject || item.commit.slice(0, 7)}`,
      description:
        'Recovered code from Git. The older database did not contain its conversation or original parent.',
      ...(item.folder === null ? {} : { worktreePath: item.folder }),
    },
    item.commit,
    actual?.branch ?? null,
    item.folder !== null,
  );
  store.setMetadata(`recovered:${item.ref}`, node.id);
  return { nodeId: node.id, preservedPath };
}
