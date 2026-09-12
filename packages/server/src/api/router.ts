import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CreateNodeRequest,
  CreateProjectRequest,
  NodeDetail,
  RecoverRequest,
  StartRunRequest,
  TreeResponse,
  UpdateNodeRequest,
  UpdateProjectRequest,
  UpdateSettingsRequest,
} from '@bonsai/shared';
import type { AdoptProjectRequest, DirectoryInspectionView } from '@bonsai/shared';

import { isUsersOwnCheckout, type Store } from '../db/store.js';
import type { EventBus } from './events.js';
import type { RunJobs } from '../jobs/runNode.js';
import {
  adoptProject,
  createChildNode,
  createProject,
  deleteNodeTree,
  deleteProjectTree,
  projectDeletionImpact,
} from '../projects.js';
import { nodeDiff, runDiff } from '../git/diff.js';
import { inspectDirectory } from '../git/adopt.js';
import { listDirectory } from './browse.js';
import { discardWorktreeChanges } from '../git/recovery.js';
import type { Settings } from '../settings.js';
import { Connection, revealInFileManager } from './connectionGate.js';
import { readContextFile } from '../git/context.js';
import { HttpError, notYet, readJson, requireString, sendError, sendJson } from './http.js';

interface Ctx {
  store: Store;
  bus: EventBus;
  jobs: RunJobs;
  settings: Settings;
  connection: Connection;
}

/**
 * Anything that would spend money or start an agent requires a working
 * credential. 428 Precondition Required, so the UI can tell this apart from a
 * bug and show the connection screen rather than an error.
 */
function requireConnection(connection: Connection): void {
  if (connection.isConnected()) return;
  const status = connection.current();
  throw new HttpError(
    428,
    status.message ??
      'Bonsai is not connected to Claude. Open Settings to sign in or add an API key.',
  );
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: Ctx,
) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
}

function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i += 1) {
      const seg = r.segments[i]!;
      const part = parts[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
      else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// -- connection and settings -------------------------------------------------

route('GET', '/api/connection', (_req, res, _p, { connection }) => {
  sendJson(res, 200, connection.current());
});

route('POST', '/api/connection/check', async (_req, res, _p, { connection }) => {
  sendJson(res, 200, await connection.check());
});

route('POST', '/api/connection/login', async (_req, res, _p, { connection }) => {
  const result = await connection.login();
  // Whether it worked is decided by a fresh probe, not by the exit code.
  const status = await connection.check();
  sendJson(res, 200, { ...result, status });
});

route('GET', '/api/browse', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  sendJson(res, 200, await listDirectory(url.searchParams.get('path') ?? undefined));
});

/**
 * Looks at a folder without changing it, so the UI can warn before adopting.
 *
 * The database is asked FIRST, and that order is the whole point. Bonsai
 * creates worktrees and then cannot recognise them: pointing the picker at one
 * used to reach git, which answered with a sentence about linked worktrees and
 * advice ("choose that repository instead") that leads to a bare repo nobody
 * can adopt. Bonsai already knew the answer -- the path was sitting in its own
 * node table -- so it says which node it is and lets the interface offer to
 * open it.
 *
 * The lookup lives here rather than in git/adopt.ts because that module shells
 * out to git and must not grow a database dependency.
 */
route('POST', '/api/inspect', async (req, res, _p, { store }) => {
  const body = await readJson<{ path?: string }>(req);
  const path = requireString(body.path, 'path');

  const owner = store.findFolderOwner(path);
  if (owner !== null) {
    const { project, node } = owner;
    const what =
      node === null
        ? `part of your project ${project.name}`
        : `the node ${node.display_name} in your project ${project.name}`;
    const view: DirectoryInspectionView = {
      path,
      exists: true,
      isDirectory: true,
      isGitRepo: true,
      branch: null,
      headCommit: null,
      dirtyFiles: 0,
      entryCount: 0,
      blockedReason: `This folder is ${what}. It is already in Bonsai.`,
      knownTo: {
        projectId: project.id,
        projectName: project.name,
        nodeId: node?.id ?? null,
        nodeName: node?.display_name ?? null,
      },
    };
    sendJson(res, 200, view);
    return;
  }

  sendJson(res, 200, { ...(await inspectDirectory(path)), knownTo: null });
});

route('GET', '/api/settings', (_req, res, _p, { settings }) => {
  sendJson(res, 200, settings.view());
});

route('PATCH', '/api/settings', async (req, res, _p, { settings, connection }) => {
  const body = await readJson<UpdateSettingsRequest>(req);
  const view = settings.update(body);
  // Auth-affecting changes invalidate what we know, so re-check immediately.
  if (body.authMode !== undefined || body.apiKey !== undefined || body.model !== undefined) {
    await connection.check();
  }
  sendJson(res, 200, view);
});

route('POST', '/api/reveal', async (req, res) => {
  const body = await readJson<{ path?: string }>(req);
  await revealInFileManager(requireString(body.path, 'path'));
  sendJson(res, 200, { ok: true });
});

// -- projects ----------------------------------------------------------------

route('GET', '/api/projects', (_req, res, _p, { store }) => {
  sendJson(res, 200, store.listProjects().map((p) => store.projectView(p)));
});

route('POST', '/api/projects', async (req, res, _p, { store, bus, settings, connection }) => {
  requireConnection(connection);
  const body = await readJson<CreateProjectRequest>(req);
  const created = await createProject(store, {
    name: requireString(body.name, 'name'),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? settings.model(),
    permissionMode: body.permissionMode ?? settings.permissionMode(),
    effort: settings.effort(),
    location: body.location ?? null,
  });
  bus.publish(created.projectId, { type: 'tree.updated', projectId: created.projectId });
  // D21 has the agent scaffold master from the description; that run starts in
  // M3. The repo, master branch, worktree and root commit all exist now.
  sendJson(res, 201, created);
});

/** Uses a folder the user already has, in place. Nothing is copied or moved. */
route('POST', '/api/projects/adopt', async (req, res, _p, { store, bus, settings, connection }) => {
  requireConnection(connection);
  const body = await readJson<AdoptProjectRequest>(req);
  const created = await adoptProject(store, {
    path: requireString(body.path, 'path'),
    name: body.name,
    description: typeof body.description === 'string' ? body.description : '',
    model: settings.model(),
    permissionMode: settings.permissionMode(),
    effort: settings.effort(),
    includeUncommitted: body.includeUncommitted === true,
  });
  bus.publish(created.projectId, { type: 'tree.updated', projectId: created.projectId });
  sendJson(res, 201, created);
});

route('GET', '/api/projects/:id/tree', (_req, res, params, { store }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body: TreeResponse = {
    project: store.projectView(project),
    nodes: store.treeView(project.id),
  };
  sendJson(res, 200, body);
});

route('PATCH', '/api/projects/:id', async (req, res, params, { store, bus }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<UpdateProjectRequest>(req);
  // D32: settings, not node state. D3's immutability is about nodes.
  store.updateProjectSettings(project.id, {
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
  });
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, store.projectView(store.getProject(project.id)!));
});

/** What deleting this project would destroy -- and, when adopted, what it won't. */
route('GET', '/api/projects/:id/deletion-impact', (_req, res, params, { store }) => {
  const impact = projectDeletionImpact(store, params['id']!);
  if (impact === null) throw new HttpError(404, 'no such project');
  sendJson(res, 200, impact);
});

route('DELETE', '/api/projects/:id', async (_req, res, params, { store, bus, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  for (const node of store.listNodes(project.id)) jobs.cancel(node.id);
  const removed = await deleteProjectTree(store, project.id);
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, { ok: true, ...removed });
});

// -- nodes -------------------------------------------------------------------

route('POST', '/api/projects/:id/nodes', async (req, res, params, { store, bus }) => {
  const projectId = params['id']!;
  if (store.getProject(projectId) === undefined) throw new HttpError(404, 'no such project');

  const body = await readJson<CreateNodeRequest>(req);
  const parentId = requireString(body.parentId, 'parentId');
  const parent = store.getNode(parentId);
  if (parent === undefined) throw new HttpError(404, 'no such parent node');
  if (parent.project_id !== projectId) throw new HttpError(400, 'parent is in another project');

  // Note there is no writability check here. Creating a child of a frozen node
  // is legal and normal -- freezing constrains what the *parent* may do next,
  // and it is checked at run start rather than continuously.

  const { nodeId } = await createChildNode(store, {
    projectId,
    parentId,
    displayName: requireString(body.displayName, 'displayName'),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
  });

  bus.publish(projectId, { type: 'tree.updated', projectId });
  // §6.2: the user stays on the canvas and the node appears immediately. The
  // run is started separately until M3 so the git layer can be driven on its
  // own; `new` is the brief window the state was kept for.
  sendJson(res, 201, { node: store.treeView(projectId).find((n) => n.id === nodeId) });
});

route('GET', '/api/nodes/:id', async (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const view = store.treeView(row.project_id).find((n) => n.id === row.id)!;
  const body: NodeDetail = {
    node: view,
    runs: store.listRuns(row.id),
    contextMd: await readContextFile(row.worktree_path),
    baseIsPinnedBehindLiveWalk: store.baseDiverges(row),
  };
  sendJson(res, 200, body);
});

route('PATCH', '/api/nodes/:id', async (req, res, params, { store, bus }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<UpdateNodeRequest>(req);
  // D3: nodes are immutable. Display name and canvas position are metadata and
  // are the only things this route will touch.
  store.updateNode(row.id, {
    ...(body.displayName !== undefined ? { displayName: requireString(body.displayName, 'displayName') } : {}),
    ...(body.positionX !== undefined ? { positionX: body.positionX } : {}),
    ...(body.positionY !== undefined ? { positionY: body.positionY } : {}),
  });
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(res, 200, store.treeView(row.project_id).find((n) => n.id === row.id));
});

/** What deleting this node would destroy, so the UI can say so before it does. */
route('GET', '/api/nodes/:id/deletion-impact', (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const doomed = store.descendantsOf(row.id);
  sendJson(res, 200, {
    nodes: doomed.length,
    costUsd: doomed.reduce((sum, n) => sum + store.nodeCost(n.id), 0),
    commits: doomed.filter((n) => n.head_commit !== null).length,
  });
});

route('DELETE', '/api/nodes/:id', async (_req, res, params, { store, bus, jobs }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.parent_id === null) throw new HttpError(400, 'deleting master means deleting the project');
  // Open Question 3, answered: cancel, then delete. Blocking the delete would
  // strand a node behind a run that may never finish.
  jobs.cancel(row.id);
  const removed = await deleteNodeTree(store, row.id);
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
  if (row.base_commit === null && row.head_commit === null) {
    throw new HttpError(400, 'master has no base to diff against');
  }
  sendJson(
    res,
    200,
    await nodeDiff(row.worktree_path, row.base_commit ?? row.head_commit!, row.head_commit !== null),
  );
});

// -- runs --------------------------------------------------------------------

route('POST', '/api/nodes/:id/runs', async (req, res, params, { store, jobs, connection }) => {
  requireConnection(connection);
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<StartRunRequest>(req);
  try {
    sendJson(res, 202, jobs.start(row.id, requireString(body.prompt, 'prompt')));
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : String(err));
  }
});

route('POST', '/api/runs/:id/cancel', (_req, res, params, { store, jobs }) => {
  const run = store.getRun(params['id']!);
  if (run === undefined) throw new HttpError(404, 'no such run');
  sendJson(res, 200, { cancelled: jobs.cancel(run.node_id) });
});
route('POST', '/api/runs/:id/reply', (_req, res) =>
  notYet('later', 'answering an agent question (the ask-user mechanism is postponed)'),
);
/** §6.6: resume / discard / keep. */
route('POST', '/api/nodes/:id/recover', async (req, res, params, ctx) => {
  const { store, bus, jobs } = ctx;
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.status === 'running') throw new HttpError(409, 'this node is still running');

  const body = await readJson<RecoverRequest>(req);
  switch (body.action) {
    case 'resume':
      requireConnection(ctx.connection);
      sendJson(res, 202, await jobs.startResume(row.id));
      return;

    case 'discard':
      // Never against the user's own checkout. `git reset --hard` plus
      // `git clean -fd` there would destroy work Bonsai did not create and
      // cannot restore -- an adopted project's master is theirs, not ours.
      if (isUsersOwnCheckout(store.getProject(row.project_id), row)) {
        throw new HttpError(
          400,
          'This node is your own folder. Bonsai will not discard changes there — use git yourself if you want them gone.',
        );
      }
      await discardWorktreeChanges(row.worktree_path);
      store.setNodeStatus(row.id, row.head_commit === null ? 'new' : 'ready');
      bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
      sendJson(res, 200, { ok: true });
      return;

    case 'keep':
      // Leaves the worktree dirty and resumable (§6.6). The node stops being
      // flagged so it is not mistaken for something needing attention, but
      // nothing is thrown away and resume stays available.
      store.setNodeStatus(row.id, row.head_commit === null ? 'new' : 'ready');
      bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
      sendJson(res, 200, { ok: true });
      return;

    default:
      throw new HttpError(400, 'action must be resume, discard or keep');
  }
});

/** The diff a single run produced, so the conversation can show it in place. */
route('GET', '/api/runs/:id/diff', async (_req, res, params, { store }) => {
  const run = store.getRun(params['id']!);
  if (run === undefined) throw new HttpError(404, 'no such run');
  if (run.commit_sha === null) throw new HttpError(400, 'this run changed nothing');
  const node = store.getNode(run.node_id);
  if (node === undefined) throw new HttpError(404, 'no such node');

  const base = store.runDiffBase(run.id);
  if (base === null) throw new HttpError(400, 'no base to diff against');
  sendJson(res, 200, await runDiff(node.worktree_path, base, run.commit_sha));
});

// -- events ------------------------------------------------------------------

route('GET', '/api/events', (req, res, _p, { bus }) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  if (projectId === null) throw new HttpError(400, 'projectId is required');
  bus.subscribe(projectId, res);
});

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  const found = match(req.method ?? 'GET', url.pathname);
  if (found === null) {
    sendError(res, new HttpError(404, `no route for ${req.method} ${url.pathname}`));
    return true;
  }
  try {
    await found.handler(req, res, found.params, ctx);
  } catch (err) {
    sendError(res, err);
  }
  return true;
}
