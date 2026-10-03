/**
 * Audit phases 10-14: a project with every state a card can be in, kept
 * running so the interface can be looked at and driven.
 *
 *   npm run build && node scripts/audit/ui-fixture.mjs <state.json> [extra-children]
 *
 * Uses the stand-in agent and a temporary data folder. Writes the server's
 * address, the project id and the experiments' ids to <state.json>, then
 * waits until it is killed. `extra-children` adds that many plain finished
 * experiments under master, for wide trees.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

import { delay, startBonsai } from './lib.mjs';

const [out, extra = '0'] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), 'bonsai-ui-'));
const bonsai = await startBonsai(join(root, 'data'), {
  BONSAI_FAKE_DELAY_MS: '20',
  BONSAI_FAKE_BACKGROUND_MS: '36000000',
});
const api = bonsai.api;
const ids = {};

const project = (
  await api('POST', '/api/projects', {
    name: 'checkout-service',
    description: 'A small service to try caching approaches on',
  })
).body;
const P = project.projectId;
ids.master = project.masterNodeId;
const make = async (key, parent, name, description = '') => {
  ids[key] = (
    await api('POST', `/api/projects/${P}/nodes`, {
      parentId: ids[parent],
      displayName: name,
      description,
    })
  ).body.node.id;
  return ids[key];
};
const run = async (key, prompt, settle = true) => {
  await api('POST', `/api/nodes/${ids[key]}/runs`, { prompt });
  if (settle) await bonsai.settle(ids[key]);
};

await run('master', 'Set up the service skeleton');
await make('behind', 'master', 'Started before the logging change', 'Add request ids');
await run('master', 'Add structured logging');
await make('redis', 'master', 'Redis cache', 'Cache product lookups in Redis');
await run('redis', 'Add a Redis cache in front of product lookups');
await make('ttl', 'redis', 'Redis cache with TTL', 'Expire entries after five minutes');
await run('ttl', 'Give cached entries a five minute TTL');
await make('question', 'ttl', 'Which eviction policy?');
await run('question', '? Which eviction policy does this use, and why?');
await make('lru', 'master', 'In-memory LRU', 'Try an in-process LRU instead of Redis');
await run('lru', 'background: build the LRU and run the benchmark', false);
await delay(800);
await api('POST', `/api/nodes/${ids.lru}/cancel`);
await bonsai.settle(ids.lru);
await make(
  'long',
  'master',
  'A very long experiment name that keeps going to see how a card copes with it',
  'Long names happen when people paste their request in as the name',
);
await run('long', 'Write the thing with the long name');
await make('archived', 'master', 'Old spike', 'A spike nobody needs any more');
await run('archived', 'Spike something');
await api('POST', `/api/nodes/${ids.archived}/archive`, {});
await make('fresh', 'master', 'Not started yet', 'Try connection pooling');
for (let i = 0; i < Number(extra); i++) {
  await make(`extra${i}`, 'master', `Variant ${i + 1}`, `Variant number ${i + 1}`);
  await run(`extra${i}`, `Variant ${i + 1}`);
}
// Last, the ones that stay busy: two hold a slot each, the third waits.
await make('choose', 'master', 'Pick a database', 'Choose between Postgres and SQLite');
await run('choose', 'choose: which database should this use?', false);
await make('dev', 'redis', 'Dev server', 'Run the service and watch it');
await run('dev', 'background: start the dev server', false);
await make('bench', 'master', 'Benchmark', 'Benchmark both caches');
await run('bench', 'background: run the benchmark', false);
await make('queued', 'master', 'Waiting its turn', 'Add a health check');
await run('queued', 'Add a health check', false);
await delay(1000);

await writeFile(out, JSON.stringify({ base: bonsai.base, projectId: P, ids, root }, null, 2));
console.log(`ready: ${bonsai.base}/?project=${P}`);
const stop = async () => {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => undefined, 60_000);
