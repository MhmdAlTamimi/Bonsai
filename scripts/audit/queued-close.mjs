/**
 * Audit phase 7: a request waiting in the queue when Bonsai closes or crashes.
 *
 *   npm run build:server && node scripts/audit/queued-close.mjs
 *
 * With one run allowed at a time, experiment A is busy and experiment B's
 * second request waits behind it. Bonsai is then closed properly (SIGTERM)
 * or crashes (SIGKILL). Reports whether B's waiting request survives
 * anywhere, how B is shown, and what Resume would send the agent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { delay, startBonsai } from './lib.mjs';

const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

for (const signal of ['SIGTERM', 'SIGKILL']) {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-queued-'));
  const dataDir = join(root, 'data');
  let bonsai = await startBonsai(dataDir, { BONSAI_FAKE_DELAY_MS: '400' });
  try {
    await bonsai.api('PATCH', '/api/settings', { maxConcurrentRuns: 1 });
    const project = (await bonsai.api('POST', '/api/projects', { name: 'q', description: '' }))
      .body;
    const make = async (name) => {
      const id = (
        await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId: project.masterNodeId,
          displayName: name,
          description: '',
        })
      ).body.node.id;
      await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `first request for ${name}` });
      await bonsai.settle(id);
      return id;
    };
    const a = await make('A');
    const b = await make('B');
    await bonsai.api('POST', `/api/nodes/${a}/runs`, { prompt: 'second request for A' });
    await bonsai.api('POST', `/api/nodes/${b}/runs`, { prompt: 'SECOND REQUEST FOR B, waiting' });
    const queued = (
      await bonsai.api('GET', `/api/projects/${project.projectId}/tree`)
    ).body.nodes.find((n) => n.id === b);
    console.log(
      `\n${signal}: B before closing: ${queued.status}, queue position ${queued.queuePosition}`,
    );
    await delay(200);
    await bonsai.stop(signal);
    bonsai = await startBonsai(dataDir, { BONSAI_FAKE_DELAY_MS: '50' });

    const detail = (await bonsai.api('GET', `/api/nodes/${b}`)).body;
    const messages = (await bonsai.api('GET', `/api/nodes/${b}/messages`)).body;
    const list = Array.isArray(messages) ? messages : (messages?.messages ?? []);
    const kept = list.some((m) => text(m).includes('SECOND REQUEST FOR B'));
    const run = detail.runs.at(-1);
    console.log(
      `  B after restart: ${detail.node.status}; its last run ${run.status}/${run.endReason}`,
    );
    console.log(`  the waiting request is in B's conversation: ${kept}`);
    if (detail.node.status === 'interrupted') {
      await bonsai.api('POST', `/api/nodes/${b}/recover`, { action: 'resume' });
      await bonsai.settle(b);
      const after = (await bonsai.api('GET', `/api/nodes/${b}/messages`)).body;
      const all = Array.isArray(after) ? after : (after?.messages ?? []);
      const sent = all.filter((m) => m.role === 'user').at(-1);
      const asks = text(sent).includes('SECOND REQUEST FOR B')
        ? 'the waiting request'
        : text(sent).includes('first request for B')
          ? 'B’s FIRST request again'
          : 'neither';
      console.log(`  Resume sends the agent: ${asks}`);
    }
  } finally {
    await bonsai.stop();
    await rm(root, { recursive: true, force: true });
  }
}
