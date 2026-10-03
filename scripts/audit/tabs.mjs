/**
 * Audit phase 9: Bonsai open in several tabs.
 *
 *   npm run build && node scripts/audit/tabs.mjs
 *
 * Each open page keeps one live-update stream (EventSource) to the server for
 * as long as it is open. The server speaks HTTP/1.1, where a browser allows
 * six connections to one host across all its tabs. Opens tabs one by one and
 * times an ordinary request from the newest tab each time.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch } from '../browser-check.mjs';
import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-tabs-'));
const bonsai = await startBonsai(join(root, 'data'));
let page;
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'tabs', description: '' }))
    .body;
  page = await launch({ url: 'about:blank' });
  await page.goto(`${bonsai.base}/?project=${project.projectId}`);
  await page.waitFor(`document.querySelectorAll('.react-flow__node').length === 1`);
  // Each further "tab" is a window this page opens on the same address, so
  // they share the browser's connection pool exactly as real tabs do.
  for (let tabs = 2; tabs <= 7; tabs++) {
    const [newest, first] = await page.eval(`(async () => {
      const w = window.open(location.href, '_blank');
      await new Promise((r) => setTimeout(r, 2500));
      const time = (win) => {
        const started = performance.now();
        const done = win.fetch(location.origin + '/api/settings').then(() => performance.now() - started);
        const timeout = new Promise((r) => setTimeout(() => r(-1), 8000));
        return Promise.race([done, timeout]).then(Math.round);
      };
      return Promise.all([time(w), time(window)]);
    })()`);
    const say = (ms) => (ms === -1 ? 'no answer after 8 s' : `${ms} ms`);
    console.log(
      `${tabs} tabs open: a request from the newest tab ${say(newest)}, from the first ${say(first)}`,
    );
  }
} finally {
  page?.close();
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
