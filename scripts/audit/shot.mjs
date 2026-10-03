/**
 * Audit phases 10-14: open a page in Chromium, optionally act on it, and save
 * a screenshot.
 *
 *   node scripts/audit/shot.mjs <url> <out.png> [WIDTHxHEIGHT] [script] [waitFor]
 *
 * `script` is JavaScript run in the page after it loads (awaited if it returns
 * a promise); `waitFor` is an expression polled until true before anything
 * else, default "a card is on the map". Prints what `script` returns.
 * CLIP="x,y,width,height" saves only that part of the window, at twice the
 * size, for reading small text.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { launch } from '../browser-check.mjs';
import { delay } from './lib.mjs';

const [url, out, size = '1280x720', script, until] = process.argv.slice(2);
const session = await launch({ url: 'about:blank', windowSize: size.replace('x', ',') });
try {
  await session.goto(url);
  await session.waitFor(until ?? `document.querySelectorAll('.react-flow__node').length > 0`, {
    timeoutMs: 30_000,
  });
  await delay(1200);
  if (script) {
    const result = await session.eval(`(async () => { ${script} })()`);
    if (result !== undefined)
      console.log(typeof result === 'string' ? result : JSON.stringify(result));
    await delay(600);
  }
  const clip = process.env.CLIP?.split(',').map(Number);
  if (clip === undefined) await session.screenshot(out);
  else {
    const [x, y, width, height] = clip;
    const shot = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: 2 },
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  }
} finally {
  session.close();
}
