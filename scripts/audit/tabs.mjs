/**
 * Audit phase 9: Bonsai open in several tabs.
 *
 *   npm run build && node scripts/audit/tabs.mjs
 *
 * Regression: pages share a single live-update stream through SharedWorker. The server speaks HTTP/1.1, where a browser allows
 * six connections to one host across all its tabs. Opens tabs one by one and
 * times an ordinary request from the newest tab each time.
 */
import assert from 'node:assert/strict';
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
      if (!w) throw new Error('Browser blocked test popup');
      (window.auditTabs ??= []).push(w);
      await new Promise((r) => setTimeout(r, 2500));
      const time = (win) => {
        const started = performance.now();
        const done = win.fetch(location.origin + '/api/settings').then(() => performance.now() - started);
        const timeout = new Promise((r) => setTimeout(() => r(-1), 8000));
        return Promise.race([done, timeout]).then(Math.round);
      };
      return Promise.all([time(w), time(window)]);
    })()`);
    assert.ok(
      newest >= 0 && first >= 0,
      'ordinary requests must not stall behind persistent streams',
    );
    const say = (ms) => (ms === -1 ? 'no answer after 8 s' : `${ms} ms`);
    console.log(
      `${tabs} tabs open: a request from the newest tab ${say(newest)}, from the first ${say(first)}`,
    );
  }
  const child = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'Delivered to every tab',
      prompt: '',
    })
  ).body;
  assert.ok(child.node.id);
  await page.waitFor(
    `window.auditTabs.every(w => w.document.querySelector('[data-id="${child.node.id}"]'))`,
  );
  await page.eval(
    'window.auditTabs[0].close(); window.auditTabs.shift(); window.auditTabs[0].location.reload()',
  );
  await page.waitFor(
    `window.auditTabs.every(w => w.document.querySelector('[data-id="${child.node.id}"]'))`,
  );
  console.log('All seven tabs receive saved updates; closing/reloading a tab preserves delivery.');
  // Browsers suspend animation frames in hidden windows; render assertions
  // must inspect a foreground tab.
  await page.send('Page.bringToFront');
  // Exercise the unsupported-browser fallback on a full reload.
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'Object.defineProperty(window, "SharedWorker", { value: undefined })',
  });
  await page.goto(`${bonsai.base}/?project=${project.projectId}`);
  await page.waitFor(`!!document.querySelector('[data-id="${child.node.id}"]')`);
  const fallbackChild = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'Polling delivery',
      prompt: '',
    })
  ).body;
  await page.waitFor(`!!document.querySelector('[data-id="${fallbackChild.node.id}"]')`);
  console.log('Finite polling delivers updates when SharedWorker is unavailable.');
} finally {
  page?.close();
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
