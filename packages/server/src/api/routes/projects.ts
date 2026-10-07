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
import { locateRepository } from '../../storage/relocate.js';
import { lostExperiments, importLostExperiment } from '../../storage/orphans.js';
import { join } from 'node:path';
import { retryWorkspaceSwitch } from '../../jobs/projectWorkspace.js';
import { restoreWorkspace } from '../../storage/workspaceRecovery.js';
import { validateRebuildPaths, withProjectWorkspace } from '../../jobs/projectWorkspace.js';
import {
  migrateProjectWorkspace,
  workspaceMigrationView,
} from '../../storage/workspaceMigration.js';

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
    ...(typeof body.startFrom === 'string' ? { startFrom: body.startFrom } : {}),
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

route('POST', '/api/projects/:id/locate', async (req, res, params, { store, jobs, bus }) => {
  const body = await readJson<{ path: string }>(req);
  const id = params['id']!;
  await jobs.pool.withStoppedProject(id, () =>
    jobs.withStoppedNodes(
      store.listNodes(id).map((node) => node.id),
      () => locateRepository(store, id, requireString(body.path, 'path')),
    ),
  );
  bus.publish(id, { type: 'tree.updated', projectId: id });
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/projects/:id/lost-experiments', async (_req, res, params, { store }) => {
  sendJson(res, 200, await lostExperiments(store, params['id']!));
});
route(
  'POST',
  '/api/projects/:id/lost-experiments',
  async (req, res, params, { store, settings, bus, jobs }) => {
    const body = await readJson<{ id: string; version: string }>(req);
    const recovered = await jobs.pool.withResource(params['id'], () =>
      withProjectWorkspace(store, params['id']!, () =>
        importLostExperiment(
          store,
          params['id']!,
          requireString(body.id, 'id'),
          requireString(body.version, 'version'),
          join(settings.view().dataDir, 'recovery'),
        ),
      ),
    );
    bus.publish(params['id']!, { type: 'tree.updated', projectId: params['id']! });
    sendJson(res, 201, recovered);
  },
);

route('GET', '/api/projects/:id/usage', (_req, res, params, { store }) => {
  const project = store.getProject(params['id']!);
  if (!project) throw new HttpError(404, 'no such project');
  sendJson(res, 200, store.usage.view(project.id));
});

route(
  'POST',
  '/api/projects/:id/workspace-recovery',
  async (req, res, params, { store, jobs, bus, settings }) => {
    const id = params['id']!;
    const body = await readJson<{ action: string }>(req);
    if (body.action !== 'retry' && body.action !== 'restore')
      throw new HttpError(400, 'Choose retry or restore.');
    let preservedPath: string | null = null;
    await jobs.pool.withResource(id, () =>
      withProjectWorkspace(store, id, async () => {
        if (body.action === 'restore' || store.metadata(`workspace_recovery:${id}`))
          preservedPath = await restoreWorkspace(
            store,
            id,
            join(settings.view().dataDir, 'recovery'),
          );
        else await retryWorkspaceSwitch(store, id);
      }),
    );
    jobs.pool.refresh();
    bus.publish(id, { type: 'tree.updated', projectId: id });
    sendJson(res, 200, { preservedPath });
  },
);

route('PATCH', '/api/projects/:id', async (req, res, params, { store, bus, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<UpdateProjectRequest>(req);
  if (
    (body.setupCommand !== undefined ||
      body.copyFiles !== undefined ||
      body.rebuildPaths !== undefined) &&
    (store.metadata(`workspace_migration:${project.id}`) ||
      store.metadata(`workspace_recovery:${project.id}`) ||
      store.workspaces.get(project.id)?.switch_json)
  )
    throw new HttpError(409, 'Finish workspace conversion or recovery before changing setup.');
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
  if (
    body.rebuildPaths !== undefined &&
    (!Array.isArray(body.rebuildPaths) ||
      !body.rebuildPaths.every((path) => typeof path === 'string'))
  )
    throw new HttpError(400, 'Regeneratable folders must be a list of paths.');
  const configuration = {
    ...body,
    ...(body.rebuildPaths !== undefined
      ? { rebuildPaths: validateRebuildPaths(body.rebuildPaths) }
      : {}),
    ...(body.copyFiles !== undefined
      ? { copyFiles: body.copyFiles.map((p) => p.trim()).filter(Boolean) }
      : {}),
  };
  await jobs.pool.withResource(store.workspaces.get(project.id) ? project.id : undefined, () =>
    withProjectWorkspace(store, project.id, () =>
      Promise.resolve(store.saveProjectConfiguration(project.id, configuration)),
    ),
  );
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, store.projectView(store.getProject(project.id)!));
});

route('GET', '/api/projects/:id/workspace-migration', async (_req, res, params, { store }) => {
  sendJson(res, 200, await workspaceMigrationView(store, params['id']!));
});

route(
  'POST',
  '/api/projects/:id/workspace-migration',
  async (req, res, params, { store, jobs, bus }) => {
    const id = params['id']!;
    if (jobs.pool.jobs().some((job) => job.projectId === id))
      throw new HttpError(409, 'Finish or stop project jobs before converting its workspace.');
    const body = await readJson<{ version: string }>(req);
    await jobs.pool.withStoppedProject(id, () =>
      jobs.pool.withResource(id, () =>
        migrateProjectWorkspace(store, id, requireString(body.version, 'version')),
      ),
    );
    bus.publish(id, { type: 'tree.updated', projectId: id });
    sendJson(res, 200, store.projectView(store.getProject(id)!));
  },
);

route(
  'POST',
  '/api/projects/:id/workspace-hold',
  async (req, res, params, { store, jobs, bus }) => {
    const id = params['id']!;
    const workspace = store.workspaces.get(id);
    if (!workspace) throw new HttpError(400, 'This project does not use a shared workspace.');
    const body = await readJson<{ held: boolean; nodeId: string }>(req);
    if (typeof body.held !== 'boolean' || body.nodeId !== workspace.active_node_id)
      throw new HttpError(409, 'The active experiment changed. Refresh before changing its hold.');
    if (workspace.switch_json) throw new HttpError(409, 'Finish workspace recovery first.');
    const owner = jobs.pool.resourceOwner(id);
    if (jobs.pool.resourceBusy(id) && owner?.id !== jobs.activeRunId(body.nodeId))
      throw new HttpError(
        409,
        'The workspace is preparing another experiment. Retry when it finishes.',
      );
    store.workspaces.hold(id, body.held);
    jobs.pool.refresh();
    bus.publish(id, { type: 'tree.updated', projectId: id });
    sendJson(res, 200, { ok: true });
  },
);

/** What deleting this project would destroy -- and, when adopted, what it won't. */
route('GET', '/api/projects/:id/deletion-impact', (_req, res, params, { store }) => {
  const impact = projectDeletionImpact(store, params['id']!);
  if (impact === null) throw new HttpError(404, 'no such project');
  sendJson(res, 200, impact);
});

route('DELETE', '/api/projects/:id', async (_req, res, params, { store, bus, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const removed = await jobs.pool.withStoppedProject(project.id, () =>
    jobs.withStoppedNodes(
      store.listNodes(project.id).map((node) => node.id),
      () => deleteProjectTree(store, project.id),
    ),
  );
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, { ok: true, ...removed });
});
