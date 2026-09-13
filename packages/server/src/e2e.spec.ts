import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One end-to-end pass through the real interface, in a real browser.
 *
 * The bug this exists for is specific and has happened twice: the canvas going
 * blank after a refetch. React Flow hides a node it has not measured, so any
 * change that breaks the measurement plumbing leaves an empty canvas with no
 * error anywhere -- nothing throws, nothing logs, every unit test still passes,
 * and the app is unusable. Only a browser can see it.
 *
 * So the assertion that matters is not "two cards exist" but "two cards are
 * still VISIBLE after the tree has been refetched". A card React Flow has
 * hidden is present in the DOM with zero size, which is exactly why counting
 * elements would pass while the screen was empty.
 *
 * Cheap and deterministic because of BONSAI_FAKE_AGENT: no credentials, no
 * network, no cost, and a temporary data directory so it can never see a real
 * project.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/e2e.test.js -> packages/server/dist -> repo root
const repoRoot = resolve(here, '..', '..', '..');
const PORT = 8900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

/** Skipped rather than failed when the built interface or a browser is absent. */
function reasonToSkip(): string | null {
  if (!existsSync(join(repoRoot, 'packages/ui/dist/index.html'))) {
    return 'the interface has not been built (npm run build:ui)';
  }
  return null;
}

describe('the interface, end to end', { skip: reasonToSkip() ?? false }, () => {
  let dataDir: string;
  let server: ChildProcess;
  let session: Awaited<ReturnType<typeof launchBrowser>>;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bonsai-e2e-'));
    server = spawn(
      process.execPath,
      ['--no-warnings', join(repoRoot, 'packages/server/dist/index.js')],
      {
        env: {
          ...process.env,
          BONSAI_DATA_DIR: dataDir,
          BONSAI_PORT: String(PORT),
          BONSAI_FAKE_AGENT: '1',
          BONSAI_FAKE_DELAY_MS: '700',
        },
        stdio: 'ignore',
      },
    );

    await waitForServer();
    session = await launchBrowser();
    await session.goto(BASE);
  });

  after(async () => {
    session?.close();
    server?.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  });

  test('creates a project, adds a child, and both cards stay visible', async (t) => {
    try {
      // The start screen, since the data directory is empty.
      await session.waitFor("!!document.querySelector('.new-project')", {
        label: 'the start screen',
      });
      await session.type('.new-project input[aria-label="project name"]', 'e2e');
      await session.type('.new-project textarea', 'a project made by the end-to-end test');
      assert.equal(
        await session.eval("document.querySelector('.new-project .row button').disabled"),
        true,
      );
      await session.eval(
        "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Change folder…').click()",
      );
      await session.waitFor("!!document.querySelector('.picker-list button')");
      assert.equal(
        await session.eval("document.querySelector('.new-project .row button').disabled"),
        true,
        'browsing home does not choose it',
      );
      await session.type('.picker input', dataDir);
      await session.click('.picker-bar button:nth-of-type(2)');
      await session.waitFor(
        `document.querySelector('.picker input').value === ${JSON.stringify(dataDir)} && !document.querySelector('.picker > button').disabled`,
      );
      await session.click('.picker > button');
      await session.waitFor("!document.querySelector('.new-project .row button').disabled");
      await session.click('.new-project .row button');

      // One card: master.
      await session.waitFor(`${VISIBLE_CARDS} === 1`, {
        label: 'master to render',
        timeoutMs: 30000,
      });

      // A child, dragged out of master's handle onto empty canvas -- the real
      // gesture, through the real input pipeline, not a synthetic event.
      await session.dragTo('.react-flow__node .react-flow__handle-bottom', {
        x: 320,
        y: 620,
      });
      await session.waitFor('!!document.querySelector(\'[aria-label="what should change"]\')', {
        label: 'the new-child dialog',
      });
      // One field now (4.10): the name is derived from what you type here.
      await session.type('[aria-label="what should change"]', 'do a thing');
      // `.primary`, not the first button in the row -- that one is Cancel, and
      // clicking it closes the dialog while every later wait times out saying
      // nothing about why.
      await session.click('.dialog-actions button.primary');

      // Two cards, both actually visible.
      await session.waitFor(`${VISIBLE_CARDS} === 2`, {
        label: 'two visible cards',
        timeoutMs: 30000,
      });

      /**
       * Now watch the canvas across a series of refetches.
       *
       * This is the whole point, and getting it wrong is easy: polling from
       * Node samples every few hundred milliseconds, and the blank canvas
       * lasts only until React Flow re-measures -- a handful of frames. A
       * sampled check passes while the bug is present, which is worse than no
       * check at all. Verified by reintroducing the bug: the sampled version
       * stayed green.
       *
       * So the page watches itself, once per animation frame, and remembers
       * the WORST count it ever saw. A single blank frame is enough to fail.
       */
      await session.eval(`(() => {
        window.__worst = Infinity;
        const tick = () => {
          window.__worst = Math.min(window.__worst, ${VISIBLE_CARDS});
          window.__raf = requestAnimationFrame(tick);
        };
        tick();
        return true;
      })()`);

      // Force refetches the way the app does: every run that finishes
      // publishes a tree update, and each update rebuilds the canvas.
      for (let i = 0; i < 4; i += 1) {
        await session.eval(`(async () => {
          const tree = await (await fetch('/api/projects/' + (await (await fetch('/api/projects')).json())[0].id + '/tree')).json();
          const leaf = tree.nodes.find((n) => n.parentId !== null) ?? tree.nodes[0];
          await fetch('/api/nodes/' + leaf.id + '/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '?just a question' }),
          });
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 900));
      }

      const worst = (await session.eval('window.__worst')) as number;
      await session.eval('cancelAnimationFrame(window.__raf)');
      assert.equal(
        worst,
        2,
        `the canvas dropped to ${worst} visible cards during a refetch (it should never drop below 2)`,
      );
    } catch (err) {
      // A CI log saying "timed out waiting for the start screen" is true and
      // nearly useless -- the first failure of this test was the connection
      // screen sitting where the app should have been, and nothing in the
      // output said so. The screenshot proves it; this says it in text, which
      // is what someone reads first.
      const shot = await session.screenshot(join(repoRoot, 'test-results', 'e2e-failure.png'));
      if (shot !== null) t.diagnostic(`screenshot: ${shot}`);
      t.diagnostic(`page: ${JSON.stringify(await session.eval(WHAT_IS_ON_SCREEN))}`);
      throw err;
    }
  });
  test('draft ownership and failed node loads survive selection and delayed acknowledgments', async () => {
    await session.eval(`(async () => {
      const p = (await (await fetch('/api/projects')).json())[0];
      window.__nodes = (await (await fetch('/api/projects/' + p.id + '/tree')).json()).nodes;
      window.__root = window.__nodes.find(n => n.parentId === null).id;
      window.__child = window.__nodes.find(n => n.parentId !== null).id;
      return true;
    })()`);
    const select = async (which: string): Promise<void> => {
      await session.eval(`document.querySelector('[data-id="' + window.__${which} + '"]').click()`);
      await session.waitFor(
        `document.querySelector('.panel h2')?.textContent === window.__nodes.find(n => n.id === window.__${which}).displayName`,
      );
      await session.eval("document.querySelector('.composer-open')?.click()");
    };
    await select('root');
    await session.type('.composer textarea', 'draft for root');
    await select('child');
    await session.type('.composer textarea', 'draft for child');
    await select('root');
    assert.equal(
      await session.eval("document.querySelector('.composer textarea').value"),
      'draft for root',
    );
    await session.eval(`(() => {
      window.__fetch = window.fetch;
      window.fetch = (url, init) => {
        if (String(url).endsWith('/runs') && init?.method === 'POST') {
          return new Promise(resolve => { window.__ack = () => resolve(new Response(JSON.stringify({runId: 'delayed'}))); });
        }
        return window.__fetch(url, init);
      };
    })()`);
    await session.click('.composer-row button');
    await session.waitFor('!!window.__ack');
    await select('child');
    await session.type('.composer textarea', 'newer child draft');
    await session.eval('window.__ack()');
    assert.equal(
      await session.eval("document.querySelector('.composer textarea').value"),
      'newer child draft',
    );
    await select('root');
    assert.equal(await session.eval("document.querySelector('.composer textarea').value"), '');
    await session.eval(`(() => {
      window.fetch = (url, init) => {
        if (String(url).startsWith('/api/nodes/' + window.__child) && !init?.method) {
          return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({error: 'fixture load failed'}), {status: 503})), 500));
        }
        return window.__fetch(url, init);
      };
    })()`);
    await select('child');
    assert.equal(
      await session.eval("!!document.querySelector('.checkout, .checks pre, .transcript')"),
      false,
    );
    await session.waitFor(
      "document.querySelector('.panel').textContent.includes('Retry conversation') && document.querySelector('.panel').textContent.includes('Retry details')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.panel').textContent.includes('No conversation yet')",
      ),
      false,
    );
    await session.eval('window.fetch = window.__fetch');
    await session.eval(
      "Array.from(document.querySelectorAll('.panel button')).filter(b => b.textContent.startsWith('Retry')).forEach(b => b.click())",
    );
    await session.waitFor(
      "!document.querySelector('.panel').textContent.includes('Retry conversation') && !document.querySelector('.panel').textContent.includes('Loading conversation')",
    );
    assert.equal(
      await session.eval("document.querySelector('.composer textarea').value"),
      'newer child draft',
    );
  });
  test('partial work remains visible after Keep and Discard requires confirmation', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'recovery',
          description: 'recovery fixture',
          location: dataDir,
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'partial fixture' }),
    });
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).partialWork?.untracked.length > 0)()`,
    );
    const cancelled = await fetch(`${nodeUrl}/cancel`, { method: 'POST' });
    assert.equal(cancelled.ok, true);
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.panel > .recover .partial-review')");
    await session.click('.partial-review summary');
    assert.equal(
      await session.eval(
        "document.querySelector('.partial-review').textContent.includes('untracked')",
      ),
      true,
    );
    await session.eval(
      "Array.from(document.querySelectorAll('.recover button')).find(b => b.textContent.trim() === 'Keep partial work').click()",
    );
    await session.waitFor(
      "document.querySelector('.recover')?.textContent.includes('Partial work kept — not committed')",
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-1-partial-work.png'));
    const before = (await (await fetch(nodeUrl)).json()) as { partialWork: { changed: string[] } };
    assert.ok(before.partialWork.changed.length > 0);
    await session.eval(
      "Array.from(document.querySelectorAll('.recover button')).find(b => b.textContent.includes('Discard')).click()",
    );
    await session.waitFor("!!document.querySelector('.dialog.confirm')");
    assert.equal(
      await session.eval(
        "document.querySelector('.dialog.confirm').textContent.includes('master') && document.querySelector('.dialog.confirm').textContent.includes('untracked')",
      ),
      true,
    );
    await session.click('.dialog.confirm .dialog-actions button');
    assert.deepEqual(
      ((await (await fetch(nodeUrl)).json()) as typeof before).partialWork.changed,
      before.partialWork.changed,
    );
    await session.eval(
      "Array.from(document.querySelectorAll('.recover button')).find(b => b.textContent.includes('Discard')).click()",
    );
    await session.waitFor("!!document.querySelector('.dialog.confirm')");
    await session.click('.dialog.confirm button.destructive');
    await session.waitFor("!document.querySelector('.recover')");
    assert.deepEqual(
      ((await (await fetch(nodeUrl)).json()) as typeof before).partialWork.changed,
      [],
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-1-review.png'));
  });
});

/**
 * Counts cards React Flow is actually showing.
 *
 * Not `querySelectorAll('.card').length`. A node React Flow has not measured is
 * in the DOM with `visibility: hidden` and zero size -- present to a selector,
 * invisible on screen. Counting elements is exactly the check that would have
 * passed throughout the blank-canvas bug.
 */
const VISIBLE_CARDS = `Array.from(document.querySelectorAll('.react-flow__node')).filter((n) => {
  const s = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
}).length`;

/** Enough of the page to recognise which screen is up, when one is not expected. */
const WHAT_IS_ON_SCREEN = `({
  heading: document.querySelector('h1, h2')?.textContent ?? null,
  connection: document.querySelector('.conn, .connect')?.textContent ?? null,
  error: document.querySelector('.error, .banner')?.textContent ?? null,
  crashed: !!document.querySelector('.crash'),
  cards: document.querySelectorAll('.react-flow__node').length,
})`;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/settings`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error('the server never came up');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Loaded at run time so the harness stays a plain script with no build step. */
async function launchBrowser(): Promise<{
  goto(url: string): Promise<void>;
  eval(expression: string): Promise<unknown>;
  waitFor(
    expression: string,
    options?: { timeoutMs?: number; intervalMs?: number; label?: string },
  ): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  dragTo(selector: string, to: { x: number; y: number }): Promise<void>;
  screenshot(path: string): Promise<string | null>;
  close(): void;
}> {
  const mod = (await import(pathToUrl(join(repoRoot, 'scripts', 'browser-check.mjs')))) as {
    launch: (opts?: { url?: string }) => Promise<never>;
  };
  return mod.launch();
}

function pathToUrl(path: string): string {
  return new URL(`file://${path}`).href;
}
