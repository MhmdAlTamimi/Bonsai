/**
 * A minimal browser smoke check, over the Chrome DevTools Protocol.
 *
 * Not a test framework and not a dependency: it drives the Chromium that is
 * already on the machine using Node's built-in WebSocket, so a change to the
 * interface can be checked in a real browser without adding Playwright to a
 * project whose dependency list is short on purpose.
 *
 * `--dump-dom` is not usable here. Bonsai holds an EventSource open for the
 * whole session, so the page never finishes loading by Chromium's definition
 * and the dump never prints. Evaluating an expression after the app has had a
 * moment to render sidesteps that entirely.
 *
 *   node scripts/browser-check.mjs <url> '<javascript expression>'
 *
 * The expression is evaluated in the page and its result printed as JSON.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CHROME =
  process.env['BONSAI_CHROME'] ??
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

const url = process.argv[2];
const expression = process.argv[3] ?? 'document.body.innerHTML.length';
const settleMs = Number(process.argv[4] ?? 3000);
if (url === undefined) {
  console.error('usage: browser-check.mjs <url> [expression] [settleMs]');
  process.exit(2);
}

const port = 9222 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    '--no-sandbox',
    '--disable-gpu',
    '--headless',
    '--window-size=1400,900',
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let code = 1;
try {
  const target = await waitForTarget(port);
  const ws = new WebSocket(target);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const resolve = pending.get(msg.id);
    if (resolve !== undefined) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable', {});
  await send('Page.navigate', { url });
  // The app renders after its first few fetches settle; there is no load event
  // to wait for, so waiting a beat is the honest approach.
  await delay(settleMs);

  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const details = result.result?.exceptionDetails;
  if (details !== undefined) {
    console.error('page threw:', details.exception?.description ?? details.text);
  } else {
    console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
    code = 0;
  }
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
process.exit(code);

async function waitForTarget(p) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error('Chromium never opened a debugging port');
}
