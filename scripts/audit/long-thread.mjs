/**
 * Audit phase 11: the panel with a long conversation open.
 *
 *   npm run build && node scripts/audit/long-thread.mjs [runs...]
 *
 * For each length (default 50, 200, 500 runs of one experiment), opens the
 * experiment and measures how long until its conversation is drawn, how many
 * elements the page then holds, and the page's main-thread time for each
 * "tree changed" event — made here by renaming ANOTHER experiment, the same
 * event every run anywhere in the project sends several of.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch } from '../browser-check.mjs';
import { delay, startBonsai } from './lib.mjs';

const lengths = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [50, 200, 500];

for (const length of lengths) {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-thread-'));
  const bonsai = await startBonsai(join(root, 'data'), { BONSAI_FAKE_DELAY_MS: '1' });
  let page;
  try {
    const project = (await bonsai.api('POST', '/api/projects', { name: 'thread', description: '' }))
      .body;
    const make = async (name) =>
      (
        await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId: project.masterNodeId,
          displayName: name,
          description: '',
        })
      ).body.node.id;
    const long = await make('long');
    const other = await make('other');
    for (let i = 0; i < length; i++) {
      await bonsai.api('POST', `/api/nodes/${long}/runs`, {
        prompt: `Step ${i + 1}: change the handler and explain what changed and why it matters`,
      });
      await bonsai.settle(long);
    }
    page = await launch({ url: 'about:blank' });
    await page.send('Performance.enable');
    const opened = performance.now();
    await page.goto(`${bonsai.base}/?project=${project.projectId}&node=${long}`);
    await page.waitFor(`document.querySelectorAll('.turn').length >= ${length}`, {
      timeoutMs: 180_000,
    });
    const drawMs = Math.round(performance.now() - opened);
    await delay(2000);
    const elements = await page.eval(`document.getElementsByTagName('*').length`);
    const busy = async () => {
      const { result } = await page.send('Performance.getMetrics');
      return result.metrics.find((m) => m.name === 'TaskDuration').value * 1000;
    };
    const before = await busy();
    for (let i = 0; i < 5; i++) {
      await bonsai.api('PATCH', `/api/nodes/${other}`, { displayName: `other ${i}` });
      await delay(1500);
    }
    const perUpdate = Math.round(((await busy()) - before) / 5);
    console.log(
      `${length} runs: conversation drawn in ${drawMs} ms, ${elements} elements on the page; main-thread time per update elsewhere in the project ${perUpdate} ms`,
    );
  } finally {
    page?.close();
    await bonsai.stop();
    await rm(root, { recursive: true, force: true });
  }
}
