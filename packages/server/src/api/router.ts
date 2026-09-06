import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CreateNodeRequest,
  CreateProjectRequest,
  NodeDetail,
  TreeResponse,
  UpdateNodeRequest,
} from '@bonsai/shared';

import type { Store } from '../db/store.js';
import type { EventBus } from './events.js';
import { HttpError, notYet, readJson, requireString, sendError, sendJson } from './http.js';

interface Ctx {
  store: Store;
  bus: EventBus;
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

// -- projects ----------------------------------------------------------------

route('GET', '/api/projects', (_req, res, _p, { store }) => {
  sendJson(res, 200, store.listProjects().map((p) => store.projectView(p)));
});

route('POST', '/api/projects', async (req, res) => {
  await readJson<CreateProjectRequest>(req);
  // Creating a project means creating a bare repo, a root commit, master's
  // worktree, and then a scaffolding run (D21). All of that is the git layer.
  notYet('M2', 'creating a project');
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

route('DELETE', '/api/projects/:id', (_req, res, params, { store, bus }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  store.deleteProject(project.id);
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, { ok: true });
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

  const node = store.createNode({
    projectId,
    parentId,
    displayName: requireString(body.displayName, 'displayName'),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
  });

  bus.publish(projectId, { type: 'tree.updated', projectId });
  // §6.2 starts the run here and the user stays on the canvas. No agent in M1,
  // so the node stays in `new` -- which is exactly the brief window the state
  // was kept for.
  sendJson(res, 201, { node: store.treeView(projectId).find((n) => n.id === node.id) });
});

route('GET', '/api/nodes/:id', (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const view = store.treeView(row.project_id).find((n) => n.id === row.id)!;
  const body: NodeDetail = {
    node: view,
    runs: store.listRuns(row.id),
    contextMd: null,
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

route('DELETE', '/api/nodes/:id', (_req, res, params, { store, bus }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.parent_id === null) throw new HttpError(400, 'deleting master means deleting the project');
  if (row.status === 'running') notYet('M3', 'cancelling a running node before deleting it');
  store.deleteNode(row.id);
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/nodes/:id/messages', (req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  sendJson(res, 200, store.listMessages(row.id, Number.isFinite(afterSeq) ? afterSeq : 0));
});

route('GET', '/api/nodes/:id/diff', (_req, res) => notYet('M2', 'reading a node diff'));

// -- runs --------------------------------------------------------------------

route('POST', '/api/nodes/:id/runs', (_req, res) => notYet('M3', 'starting an agent run'));
route('POST', '/api/runs/:id/cancel', (_req, res) => notYet('M3', 'cancelling a run'));
route('POST', '/api/runs/:id/reply', (_req, res) =>
  notYet('later', 'answering an agent question (the ask-user mechanism is postponed)'),
);
route('POST', '/api/nodes/:id/recover', (_req, res) => notYet('M4', 'interrupted-run recovery'));

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
