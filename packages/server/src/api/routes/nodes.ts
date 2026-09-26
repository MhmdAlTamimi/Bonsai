import { join } from 'node:path';
import { resolveRunSettings } from '../../jobs/runSettings.js';
import type {
  NodeDeletionImpactView,
  CreateNodeRequest,
  NodeDetail,
  UpdateNodeRequest,
} from '@bonsai/shared';
import { deriveNodeName } from '@bonsai/shared';
import { isUsersOwnCheckout } from '../../db/store.js';
import { copyParentConversation } from '../../jobs/conversation.js';
import { allocateNodeWorktree, createChildNode, deleteNodeTree } from '../../projects.js';
import { archiveCheck, archiveFolder } from '../../archive.js';
import { writeApplyPatch } from '../applyPatch.js';
import { nodeDiff, parentSnapshot } from '../../git/diff.js';
import { experimentNotes, reviewOf, reviewPatchOf } from '../review.js';
import { readWorktreeState } from '../../git/recovery.js';
import { revealInFileManager } from '../reveal.js';
import { testingSection, testingNotesCommit } from '../../git/context.js';
import { HttpError, readJson, requireString, sendJson } from '../http.js';
import { route, withLive } from '../routing.js';

/** Experiments: creating, reading, renaming and deleting them, and reading their changes. */

route('POST', '/api/projects/:id/nodes', async (req, res, params, ctx) => {
  const { store, bus, jobs } = ctx;
  const projectId = params['id']!;
  if (store.getProject(projectId) === undefined) throw new HttpError(404, 'no such project');

  const body = await readJson<CreateNodeRequest>(req);
  const parentId = requireString(body.parentId, 'parentId');
  const parent = store.getNode(parentId);
  if (parent === undefined) throw new HttpError(404, 'no such parent node');
  if (jobs.isRetiring(parent.id)) throw new HttpError(409, 'This experiment is being deleted.');
  if (parent.project_id !== projectId) throw new HttpError(400, 'parent is in another project');

  if (body.sourceVersion !== undefined && body.sourceVersion !== store.childSourceVersion(parent)) {
    throw new HttpError(
      412,
      'The source code changed while this dialog was open. Review the refreshed sources, then create the experiment again.',
    );
  }

  // Note there is no writability check here. Creating a child of a frozen node
  // is legal and normal -- freezing constrains what the *parent* may do next,
  // and it is checked at run start rather than continuously.

  const created = await createChildNode(store, {
    projectId,
    parentId,
    displayName:
      typeof body.displayName === 'string' && body.displayName.trim() !== ''
        ? body.displayName.trim()
        : deriveNodeName(typeof body.description === 'string' ? body.description : ''),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
    // Optional, and deliberately not validated into existence: an empty answer
    // means the node behaves exactly as nodes did before these were asked.
    successCriteria: typeof body.successCriteria === 'string' ? body.successCriteria : null,
    verificationHint: typeof body.verificationHint === 'string' ? body.verificationHint : null,
  });
  // Before the tree is announced, so the new node never appears without the
  // conversation it is about to have.
  if (body.startFresh !== true) {
    await copyParentConversation(store, ctx.conversations, created.nodeId, ctx.log);
  }

  bus.publish(projectId, { type: 'tree.updated', projectId });

  // A file that could not be copied is told at the node it affects, not
  // buried in a log: a node missing its .env will fail its checks later for a
  // reason that has nothing to do with the code.
  for (const outcome of created.seeded) {
    if (outcome.copied) continue;
    store.appendMessage({
      nodeId: created.nodeId,
      runId: null,
      role: 'system',
      kind: 'text',
      content: `Could not copy ${outcome.path} into this node: ${outcome.reason ?? 'unknown reason'}`,
    });
  }

  // Node allocation and execution are separate operations; return the allocated node.
  sendJson(res, 201, {
    node: withLive(jobs, store.treeView(projectId)).find((n) => n.id === created.nodeId),
  });
});

route('GET', '/api/nodes/:id/child-preview', (_req, res, params, { store, jobs, settings }) => {
  const parent = store.getNode(params['id']!);
  if (parent === undefined) throw new HttpError(404, 'no such parent experiment');
  sendJson(res, 200, {
    nextRunSettings: resolveRunSettings(
      { model: null, permission_mode: null },
      store.getProject(parent.project_id)!,
      settings,
    ),
    setup: store.projectView(store.getProject(parent.project_id)!).setup,
    lineage: store.childLineageOf(parent),
    sourceVersion: store.childSourceVersion(parent),
    parentActive: jobs.isRunning(parent.id),
    codeNote: 'Starts from this committed code snapshot. Uncommitted partial work is excluded.',
    conversationNote:
      parent.session_id === null
        ? `${parent.display_name} has no conversation yet, so this experiment starts its own.`
        : `Copies ${parent.display_name}'s conversation up to its last finished run. Later messages there are not added.`,
  });
});

route('GET', '/api/nodes/:id', async (_req, res, params, { store, jobs, settings }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const view = withLive(jobs, store.treeView(row.project_id)).find((n) => n.id === row.id)!;
  const { contextMd, cwd, head } = await experimentNotes(store, row);
  const project = store.getProject(row.project_id);
  const notes = testingSection(contextMd);
  const sourceCommit = await testingNotesCommit(cwd, notes, head);
  const source = sourceCommit === null ? null : store.testingSource(sourceCommit);
  const runs = store.listRuns(row.id);
  const ownFolder = isUsersOwnCheckout(project, row);
  const partialWork =
    ownFolder || row.worktree_allocated === 0 ? null : await readWorktreeState(row.worktree_path);
  const body: NodeDetail = {
    nextRunSettings: resolveRunSettings(row, project!, settings),
    node: view,
    runs,
    lineage: store.lineageOf(row),
    successCriteria: row.success_criteria,
    verificationHint: row.verification_hint,
    testingNotes: notes,
    testingSource:
      source === null
        ? null
        : {
            ...source,
            inherited: source.nodeId !== row.id,
            predatesLatestRun: source.runId !== runs.at(-1)?.id,
          },
    partialWork,
    contextMd,
    baseIsPinnedBehindLiveWalk: store.baseDiverges(row),
  };
  sendJson(res, 200, body);
});

route('PATCH', '/api/nodes/:id', async (req, res, params, { store, bus, jobs }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<UpdateNodeRequest>(req);
  for (const field of ['positionX', 'positionY'] as const) {
    if (
      body[field] !== undefined &&
      body[field] !== null &&
      (typeof body[field] !== 'number' || !Number.isFinite(body[field]))
    )
      throw new HttpError(400, 'Position must be a number or automatic.');
  }
  // D3: nodes are immutable. Display name and canvas position are metadata and
  // are the only things this route will touch.
  for (const field of ['successCriteria', 'verificationHint'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'string')
      throw new HttpError(400, `${field} must be text.`);
  }
  store.updateNode(row.id, {
    ...(body.successCriteria !== undefined ? { successCriteria: body.successCriteria } : {}),
    ...(body.verificationHint !== undefined ? { verificationHint: body.verificationHint } : {}),
    ...(body.displayName !== undefined
      ? { displayName: requireString(body.displayName, 'displayName') }
      : {}),
    ...(body.positionX !== undefined ? { positionX: body.positionX } : {}),
    ...(body.positionY !== undefined ? { positionY: body.positionY } : {}),
  });
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(
    res,
    200,
    withLive(jobs, store.treeView(row.project_id)).find((n) => n.id === row.id),
  );
});

/** What deleting this node would destroy, so the UI can say so before it does. */
route('GET', '/api/nodes/:id/deletion-impact', (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const doomed = store.descendantsOf(row.id);
  sendJson(res, 200, {
    nodes: doomed.length,
    names: doomed.map((node) => node.display_name),
    costUsd: store.runs.costOfMany(doomed.map((n) => n.id)),
    commits: doomed.filter((n) => n.head_commit !== null).length,
    comparisons: store.comparisons.including(doomed.map((n) => n.id)),
  } satisfies NodeDeletionImpactView);
});

route('DELETE', '/api/nodes/:id', async (_req, res, params, { store, bus, jobs, comparisons }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.parent_id === null)
    throw new HttpError(400, 'deleting master means deleting the project');
  // Open Question 3, answered: cancel, then delete. Blocking the delete would
  // strand a node behind a run that may never finish.
  const doomed = store.descendantsOf(row.id).map((node) => node.id);
  const announce = comparisons.beforeDeleting(doomed);
  const removed = await jobs.withStoppedNodes(doomed, () => deleteNodeTree(store, row.id));
  announce();
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(res, 200, { ok: true, removed });
});

route('GET', '/api/nodes/:id/messages', (req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  sendJson(res, 200, store.listMessages(row.id, Number.isFinite(afterSeq) ? afterSeq : 0));
});

route('GET', '/api/nodes/:id/diff', async (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.worktree_allocated === 0) {
    sendJson(res, 200, { files: [], patch: '', dirty: [] });
    return;
  }
  const first = store.listRuns(row.id).find((run) => run.commitSha !== null);
  const base =
    row.base_commit ??
    (first?.commitSha != null
      ? await parentSnapshot(row.worktree_path, first.commitSha)
      : row.head_commit);
  if (base === null) throw new HttpError(400, 'No starting code snapshot is available.');
  const diff = await nodeDiff(
    row.worktree_path,
    base,
    row.parent_id === null ? first !== undefined : row.head_commit !== null,
    row.head_commit ?? base,
  );
  const source = store.lineageOf(row).codeFrom;
  sendJson(res, 200, {
    ...diff,
    baseLabel:
      row.parent_id === null
        ? 'The code before this experiment’s first modifying run'
        : `The inherited code snapshot from ${source?.displayName ?? 'its source experiment'}`,
  });
});

/** Review: what this experiment changed, file by file. No patches here. */
route('POST', '/api/nodes/:id/reveal', async (_req, res, params, { store, bus }) => {
  const node = store.getNode(params['id']!);
  if (!node) throw new HttpError(404, 'No such experiment.');
  if (node.worktree_allocated === 0 && node.archived_at === null)
    throw new HttpError(409, 'The experiment folder is created when its first run starts.');
  if (node.archived_at !== null) {
    // Archived: bring the folder back first -- it is what was asked to be seen.
    // Setup waits for the next run, which is what needs what it installs.
    await allocateNodeWorktree(store, node);
    bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
  }
  await revealInFileManager(node.worktree_path);
  sendJson(res, 200, { ok: true });
});

/**
 * Write the experiment's committed changes to a patch in Bonsai's data folder
 * and return the command that applies it. A POST because it writes a file.
 */
route('POST', '/api/nodes/:id/patch', async (_req, res, params, { store, settings }) => {
  const node = store.getNode(params['id']!);
  if (!node) throw new HttpError(404, 'No such experiment.');
  sendJson(res, 200, await writeApplyPatch(store, node, join(settings.view().dataDir, 'patches')));
});

/** Whether the folder can be archived now, and which ignored files would go with it. */
route('GET', '/api/nodes/:id/archive', async (_req, res, params, { store, jobs }) => {
  const node = store.getNode(params['id']!);
  if (!node) throw new HttpError(404, 'No such experiment.');
  sendJson(res, 200, await archiveCheck(store, node, jobs.isRunning(node.id)));
});

/**
 * Archive the folder: remove it, keep everything else. `removeIgnored` says
 * the user has seen the ignored files that go with it (see the check above).
 */
route('POST', '/api/nodes/:id/archive', async (req, res, params, { store, bus, jobs, log }) => {
  const node = store.getNode(params['id']!);
  if (!node) throw new HttpError(404, 'No such experiment.');
  const body = await readJson<{ removeIgnored?: boolean }>(req);
  await jobs.whileIdle(node.id, async () => {
    const fresh = store.getNode(node.id) ?? node;
    await archiveFolder(store, fresh, body.removeIgnored === true);
  });
  log.info('archive.done', { nodeId: node.id, projectId: node.project_id, by: 'user' });
  bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/nodes/:id/review', async (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  sendJson(res, 200, await reviewOf(store, row));
});

/** One file's patch, for the pane reading it. */
route('GET', '/api/nodes/:id/review/file', async (req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const path = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path');
  if (path === null || path === '') throw new HttpError(400, 'path is required');
  sendJson(
    res,
    200,
    await reviewPatchOf(
      store,
      row,
      path,
      new URL(req.url ?? '/', 'http://localhost').searchParams.get('view') === 'file',
    ),
  );
});
