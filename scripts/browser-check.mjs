/**
 * A browser driver, over the Chrome DevTools Protocol.
 *
 * Not a test framework and not a dependency: it drives a Chromium that is
 * already on the machine using Node's built-in WebSocket, so the interface can
 * be checked in a real browser without adding Playwright to a project whose
 * dependency list is short on purpose.
 *
 * Three things this deliberately does NOT do, each learned the hard way:
 *
 *   It never sleeps a fixed amount and hopes. `waitFor` polls an expression
 *   until it is truthy or a deadline passes. A fixed sleep is flaky on a slower
 *   runner, and a flaky check is worse than no check, because it teaches
 *   everyone to ignore a red result.
 *
 *   It does not assume where Chromium is. A list of known locations, the
 *   BONSAI_CHROME override first, and a failure that names every path it tried.
 *
 *   It captures a screenshot when something fails, because a CI log saying
 *   "expected 2, got 1" about a canvas is nearly useless on its own.
 *
 * `--dump-dom` is not usable here at all: Bonsai holds an EventSource open for
 * the session, so the page never finishes loading by Chromium's definition and
 * the dump never prints.
 *
 * As a command:
 *   node scripts/browser-check.mjs <url> '<expression>' [settleMs]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Where Chromium might be, best guess first.
 *
 * Playwright's cache is checked by glob rather than by pinned version, since
 * the version in the path changes with every Playwright release and hard-coding
 * one means the harness breaks on an upgrade with a confusing error.
 */
function chromeCandidates() {
  const out = [];
  const override = process.env['BONSAI_CHROME'];
  if (override !== undefined && override !== '') out.push(override);

  const pwRoot = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (existsSync(pwRoot)) {
    try {
      for (const entry of readdirSync(pwRoot).sort().reverse()) {
        out.push(join(pwRoot, entry, 'chrome-linux', 'headless_shell'));
        out.push(join(pwRoot, entry, 'chrome-linux', 'chrome'));
        out.push(join(pwRoot, entry, 'chrome-mac', 'Chromium.app/Contents/MacOS/Chromium'));
      }
    } catch {
      // Unreadable: fall through to the fixed list below.
    }
  }

  out.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  return out;
}

function findChrome() {
  const tried = chromeCandidates();
  for (const path of tried) if (existsSync(path)) return path;
  throw new Error(
    'No Chromium found. Set BONSAI_CHROME to a browser binary. Looked in:\n  ' + tried.join('\n  '),
  );
}

class Session {
  constructor(chrome, ws) {
    this.chrome = chrome;
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const resolve = this.pending.get(msg.id);
      if (resolve !== undefined) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      this.id += 1;
      this.pending.set(this.id, resolve);
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }

  async goto(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  /** Evaluates in the page and returns the value. Throws what the page threw. */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const details = result.result?.exceptionDetails;
    if (details !== undefined) {
      throw new Error(`page threw: ${details.exception?.description ?? details.text}`);
    }
    return result.result?.result?.value ?? null;
  }

  /**
   * Polls until the expression is truthy, then returns it.
   *
   * This replaces every fixed sleep in the harness. The interval is short
   * enough that a fast machine is not held up and the timeout long enough that
   * a slow one is not failed for being slow.
   */
  async waitFor(expression, { timeoutMs = 15000, intervalMs = 100, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = String(err);
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last: ${last})`);
      }
      await delay(intervalMs);
    }
  }

  /** The centre of an element, in viewport coordinates. Null when not present. */
  async centreOf(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  async mouse(type, x, y, button = 'left') {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }

  /**
   * A real click through the input pipeline rather than a synthetic DOM event.
   *
   * React Flow reads pointer position from the event, so a dispatched
   * `new MouseEvent('click')` with no coordinates behaves differently from a
   * click -- which is precisely the kind of difference an end-to-end test
   * exists to catch rather than to paper over.
   */
  async click(selector) {
    const at = await this.waitFor(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0; })()`,
      { label: `${selector} to be clickable` },
    );
    if (!at) throw new Error(`no element matching ${selector}`);
    const point = await this.centreOf(selector);
    await this.mouse('mousePressed', point.x, point.y);
    await this.mouse('mouseReleased', point.x, point.y);
  }

  /** Drags from one element to a point, in steps, so drag handlers see motion. */
  async dragTo(fromSelector, to, steps = 12) {
    const from = await this.centreOf(fromSelector);
    if (from === null) throw new Error(`no element matching ${fromSelector}`);
    await this.mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i += 1) {
      await this.mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
      );
    }
    await this.mouse('mouseReleased', to.x, to.y);
  }

  /** Sets a controlled React input's value and fires the events React listens for. */
  async type(selector, text) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element matching ' + ${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      // React installs its own value setter; going through the prototype's is
      // what makes it notice the change.
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async screenshot(path) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    const data = shot.result?.data;
    if (data === undefined) return null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already gone.
    }
    this.chrome.kill('SIGKILL');
  }
}

export async function launch({ url, windowSize = '1400,900' } = {}) {
  const binary = findChrome();
  const port = 9222 + Math.floor(Math.random() * 2000);
  const chrome = spawn(
    binary,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--headless',
      '--hide-scrollbars',
      `--window-size=${windowSize}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const target = await waitForTarget(port);
  const ws = new WebSocket(target);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const session = new Session(chrome, ws);
  if (url !== undefined) await session.goto(url);
  return session;
}

async function waitForTarget(port) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('Chromium never opened a debugging port');
    await delay(100);
  }
}

// -- command line -------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv[2] !== undefined) {
  const url = process.argv[2];
  const expression = process.argv[3] ?? 'document.body.innerHTML.length';
  const settleMs = Number(process.argv[4] ?? 3000);
  const session = await launch({ url });
  try {
    // As a command the expression is evaluated once, after a settle, because
    // ad-hoc probing usually wants "what does it look like now" rather than
    // "wait until this is true".
    await delay(settleMs);
    console.log(JSON.stringify(await session.eval(expression), null, 2));
  } catch (err) {
    console.error(String(err));
    const shot = await session.screenshot(join('test-results', 'browser-check-failure.png'));
    if (shot !== null) console.error(`screenshot: ${shot}`);
    process.exitCode = 1;
  } finally {
    session.close();
  }
}
