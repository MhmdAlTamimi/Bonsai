/**
 * The HTTP API. Each file under ./routes/ registers its area's routes when
 * imported; the order here is the order they are matched in.
 */
import './routes/system.js';
import './routes/projects.js';
import './routes/nodes.js';
import './routes/runs.js';
import './routes/references.js';
import './routes/comparisons.js';
import './routes/events.js';

export { handleApi } from './routing.js';
