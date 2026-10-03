/**
 * Audit phase 8: runs that are waiting — on a question to you, or on
 * background work — still hold one of the run slots.
 *
 *   npm run build:server && node scripts/audit/held-slots.mjs
 *
 * With the default of three runs at once: two experiments ask you something
 * and one leaves a background job running. A fourth experiment's request is
 * then sent. Reports how the four look after 15 seconds of nobody answering.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { delay, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-slots-'));
const bonsai = await startBonsai(join(root, 'data'), { BONSAI_FAKE_BACKGROUND_MS: '600000' });
try {
  const limit = (await bonsai.api('GET', '/api/settings')).body.maxConcurrentRuns;
  const project = (await bonsai.api('POST', '/api/projects', { name: 'slots', description: '' }))
    .body;
  const run = async (name, prompt) => {
    const id = (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: name,
        description: '',
      })
    ).body.node.id;
    await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt });
    return { id, name };
  };
  const nodes = [
    await run('asks you 1', 'choose: a database'),
    await run('asks you 2', 'choose: a framework'),
    await run('dev server', 'background: start the dev server'),
  ];
  await delay(1500);
  nodes.push(await run('your new request', 'add a test'));
  await delay(15000);
  const tree = (await bonsai.api('GET', `/api/projects/${project.projectId}/tree`)).body.nodes;
  console.log(`runs allowed at once: ${limit}; after 15 s with nobody answering:`);
  for (const { id, name } of nodes) {
    const n = tree.find((t) => t.id === id);
    console.log(
      `  ${name}: ${n.status}${n.queuePosition !== null ? `, queued at position ${n.queuePosition}` : ''}${n.activity ? `, ${n.activity.state}` : ''}`,
    );
  }
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
