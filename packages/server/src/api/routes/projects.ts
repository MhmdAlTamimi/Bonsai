import type { CreateProjectRequest, TreeResponse, UpdateProjectRequest } from '@bonsai/shared';
import type { AdoptProjectRequest } from '@bonsai/shared';
import {
  adoptProject,
  createProject,
  previewNewDirectory,
  deleteProjectTree,
  projectDeletionImpact,
} from '../../projects.js';
import { rejectPath } from '../../git/seedWorktree.js';
import { HttpError, readJson, requireString, sendJson } from '../http.js';
import { route, withLive, requireConnection } from '../routing.js';

/** Projects: creating, opening, their tree, usage and deletion. */

route('GET', '/api/projects', (_req, res, _p, { store }) => {
  sendJson(
    res,
    200,
    store.listProjects().map((p) => store.projectView(p)),
  );
});

route('POST', '/api/projects/preview', async (req, res) => {
  const body = await readJson<{ location: string; name: string }>(req);
  sendJson(res, 200, {
    path: await previewNewDirectory(
      requireString(body.location, 'location'),
      requireString(body.name, 'name'),
    ),
  });
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
    expectedPath: body.expectedPath,
  });
  bus.publish(created.projectId, { type: 'tree.updated', projectId: created.projectId });
  // D21 has the agent scaffold master from the description; that run starts in
  // The repo, master branch, worktree and root commit all exist now.
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

route('GET', '/api/projects/:id/tree', (_req, res, params, { store, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body: TreeResponse = {
    project: store.projectView(project),
    nodes: withLive(jobs, store.treeView(project.id)),
  };
  sendJson(res, 200, body);
});

route('GET', '/api/projects/:id/usage', (_req, res, params, { store }) => {
  const project = store.getProject(params['id']!);
  if (!project) throw new HttpError(404, 'no such project');
  sendJson(res, 200, {
    projectId: project.id,
    experiments: store.listNodes(project.id).map((node) => ({
      id: node.id,
      name: node.display_name,
      runs: store
        .listRuns(node.id)
        .map(
          ({
            id,
            status,
            startedAt,
            model,
            apiKeySource,
            costUsd,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          }) => ({
            id,
            status,
            startedAt,
            model,
            apiKeySource,
            costUsd,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          }),
        ),
    })),
  });
});

route('PATCH', '/api/projects/:id', async (req, res, params, { store, bus }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<UpdateProjectRequest>(req);
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string')
    throw new HttpError(400, 'Model must be a name or App default.');
  if (
    body.effort !== undefined &&
    body.effort !== null &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)
  )
    throw new HttpError(400, 'Choose a supported effort.');
  if (
    body.permissionMode !== undefined &&
    !['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(body.permissionMode)
  )
    throw new HttpError(400, 'Choose a supported permission mode.');
  if (
    body.setupCommand !== undefined &&
    body.setupCommand !== null &&
    typeof body.setupCommand !== 'string'
  )
    throw new HttpError(400, 'Setup command must be text.');
  if (
    body.copyFiles !== undefined &&
    (!Array.isArray(body.copyFiles) || !body.copyFiles.every((path) => typeof path === 'string'))
  )
    throw new HttpError(400, 'Files to copy must be a list of paths.');
  if (body.copyFiles !== undefined) {
    /**
     * Refused here rather than at node creation.
     *
     * A path that can never be copied -- node_modules, an absolute path, one
     * that escapes the project -- would otherwise be accepted silently and
     * fail on every node from then on, in a place nobody is looking. Told now,
     * while the user is looking at the field they just typed it into.
     *
     * The tracked-file check is NOT done here: whether a file is tracked is a
     * fact about the repository that can change after this is saved, so it is
     * enforced at copy time and reported with the node.
     */
    const bad = body.copyFiles
      .map((path) => ({ path, reason: rejectPath(path) }))
      .filter((entry): entry is { path: string; reason: string } => entry.reason !== null);
    if (bad.length > 0) {
      throw new HttpError(400, bad.map((b) => `${b.path}: ${b.reason}`).join('; '));
    }
  }
  store.saveProjectConfiguration(project.id, {
    ...body,
    ...(body.copyFiles !== undefined
      ? { copyFiles: body.copyFiles.map((p) => p.trim()).filter(Boolean) }
      : {}),
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
  const removed = await jobs.withStoppedNodes(
    store.listNodes(project.id).map((node) => node.id),
    () => deleteProjectTree(store, project.id),
  );
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, { ok: true, ...removed });
});
