/**
 * Audit phase 9: what the page downloads while you read one experiment's
 * conversation and other experiments in the project are running.
 *
 *   npm run build && node scripts/audit/refetch.mjs [runs-in-history]
 *
 * One experiment gets a long history (default 150 runs). The page is opened
 * on it, then ten runs happen on OTHER experiments. Counts how often the open
 * conversation is downloaded again in full, and how many bytes that is.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch } from '../browser-check.mjs';
import { delay, startBonsai } from './lib.mjs';

const history = Number(process.argv[2] ?? 150);
const COUNT = `
window.__messages = 0;
window.__trees = 0;
const native = window.fetch;
window.fetch = (url, init) => {
  if (/\\/api\\/nodes\\/[0-9a-f-]{36}\\/messages/.test(String(url))) window.__messages += 1;
  if (/\\/api\\/projects\\/[0-9a-f-]{36}\\/tree/.test(String(url))) window.__trees += 1;
  return native(url, init);
};
`;

const root = await mkdtemp(join(tmpdir(), 'bonsai-refetch-'));
const bonsai = await startBonsai(join(root, 'data'), { BONSAI_FAKE_DELAY_MS: '5' });
let page;
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'refetch', description: '' }))
    .body;
  const make = async (name) =>
    (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: name,
        description: '',
      })
    ).body.node.id;
  const long = await make('long conversation');
  for (let i = 0; i < history; i++) {
    await bonsai.api('POST', `/api/nodes/${long}/runs`, {
      prompt: `step ${i + 1} of a long piece of work`,
    });
    await bonsai.settle(long);
  }
  const others = [await make('other 1'), await make('other 2')];
  const size = Buffer.byteLength(
    JSON.stringify((await bonsai.api('GET', `/api/nodes/${long}/messages`)).body),
  );

  page = await launch({ url: 'about:blank' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT });
  await page.goto(`${bonsai.base}/?project=${project.projectId}&node=${long}`);
  await page.waitFor(`document.querySelectorAll('.react-flow__node').length === 4`, {
    timeoutMs: 30_000,
  });
  await delay(2000);
  await page.eval('window.__messages = 0; window.__trees = 0');

  for (let i = 0; i < 10; i++) {
    const id = others[i % 2];
    await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `other work ${i + 1}` });
    await bonsai.settle(id);
  }
  await delay(2000);
  const fetched = Number(await page.eval('window.__messages'));
  const trees = Number(await page.eval('window.__trees'));
  console.log(`open conversation: ${history} runs, ${(size / 1024).toFixed(0)} KB per download`);
  console.log(
    `10 runs on OTHER experiments downloaded it again ${fetched} times: ${((fetched * size) / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`and the whole map (tree) was downloaded ${trees} times`);
} finally {
  page?.close();
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
