/**
 * Audit phase 10: what one update costs the page as the map grows.
 *
 *   npm run build && node scripts/audit/map-scale.mjs [sizes...]
 *
 * For each size (default 13, 200, 500), builds a bushy tree (three children
 * per experiment), opens the map, then renames one experiment five times — each
 * rename is one "tree changed" event, the same event every run sends several
 * of — and measures the page's main-thread time per update with Chromium's
 * own counters.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch } from '../browser-check.mjs';
import { delay, startBonsai } from './lib.mjs';

const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [13, 200, 500];

for (const size of sizes) {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-mapscale-'));
  const bonsai = await startBonsai(join(root, 'data'));
  let page;
  try {
    const project = (await bonsai.api('POST', '/api/projects', { name: 'scale', description: '' }))
      .body;
    const ids = [project.masterNodeId];
    while (ids.length < size) {
      const parentId = ids[Math.floor((ids.length - 1) / 3)];
      ids.push(
        (
          await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
            parentId,
            displayName: `Experiment ${ids.length}`,
            description: '',
          })
        ).body.node.id,
      );
    }
    page = await launch({ url: 'about:blank' });
    await page.send('Performance.enable');
    const opened = performance.now();
    await page.goto(`${bonsai.base}/?project=${project.projectId}&node=${ids.at(-1)}`);
    await page.waitFor(`document.querySelectorAll('.react-flow__node').length === ${size}`, {
      timeoutMs: 120_000,
    });
    const drawMs = Math.round(performance.now() - opened);
    await delay(2000);
    const busy = async () => {
      const { result } = await page.send('Performance.getMetrics');
      return result.metrics.find((m) => m.name === 'TaskDuration').value * 1000;
    };
    const before = await busy();
    for (let i = 0; i < 5; i++) {
      await bonsai.api('PATCH', `/api/nodes/${ids.at(-1)}`, { displayName: `Renamed ${i}` });
      await delay(1500);
    }
    const perUpdate = Math.round(((await busy()) - before) / 5);
    const zoom = await page.eval(`document.querySelector('.zoom-level')?.textContent`);
    console.log(
      `${size} experiments: map drawn in ${drawMs} ms, opens at ${zoom}; main-thread time per update ${perUpdate} ms`,
    );
  } finally {
    page?.close();
    await bonsai.stop();
    await rm(root, { recursive: true, force: true });
  }
}
