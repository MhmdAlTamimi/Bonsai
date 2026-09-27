import { HttpError } from '../http.js';
import { route } from '../routing.js';

/** The project's live event stream. */

route('GET', '/api/events', (req, res, _p, { bus }) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  if (projectId === null) throw new HttpError(400, 'projectId is required');
  bus.subscribe(projectId, res);
});
