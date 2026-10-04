import { HttpError, sendJson } from '../http.js';
import { route } from '../routing.js';

/** The project's live event stream. */

route('GET', '/api/events/check', (req, res, _p, { bus }) => {
  const projectId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('projectId');
  if (!projectId) throw new HttpError(400, 'projectId is required');
  sendJson(res, 200, { revision: bus.revision(projectId) });
});

route('GET', '/api/events', (req, res, _p, { bus }) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const projectId = url.searchParams.get('all') === '1' ? '*' : url.searchParams.get('projectId');
  if (projectId === null) throw new HttpError(400, 'projectId is required');
  bus.subscribe(projectId, res);
});

route('GET', '/api/version', (_req, res, _p, { buildId }) => {
  sendJson(res, 200, { buildId: buildId ?? null });
});

route('GET', '/api/attention', (_req, res, _p, { store }) => {
  sendJson(res, 200, store.attention());
});
