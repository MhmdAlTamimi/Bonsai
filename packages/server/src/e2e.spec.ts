import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  afterEach(async (t) => {
    if ('diagnostic' in t) {
      await session.screenshot(
        join(repoRoot, 'test-results', `failure-${t.name.slice(0, 24).replaceAll(' ', '-')}.png`),
      );
      t.diagnostic(JSON.stringify(await session.eval(WHAT_IS_ON_SCREEN)));
    }
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

      await session.waitFor("document.querySelector('.panel h2')?.textContent === 'master'");
      assert.equal(await session.eval("document.querySelectorAll('.panel textarea').length"), 1);
      assert.equal(
        await session.eval("document.querySelector('.composer textarea').value"),
        'a project made by the end-to-end test',
      );
      assert.equal(await session.eval("!!document.querySelector('.checkout-section')"), false);
      await session.click('.composer-row button');
      await session.waitFor(
        "!document.querySelector('.panel button.stop') && document.querySelector('.composer-row button')?.textContent === 'Send'",
        { timeoutMs: 10000 },
      );

      // A child, dragged out of master's handle onto empty canvas -- the real
      // gesture, through the real input pipeline, not a synthetic event.
      await session.dragTo('.react-flow__node .react-flow__handle-bottom', {
        x: 320,
        y: 620,
      });
      await session.waitFor('!!document.querySelector(\'[aria-label="what should change"]\')', {
        label: 'the new-child dialog',
      });
      await session.type('[aria-label="experiment name"]', 'Named approach');
      await session.waitFor("!!document.querySelector('.creation-sources button')");
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
  test('rename changes metadata and branching discloses divergent sources', async () => {
    const p = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string }>;
    const projectId = p[0]!.id;
    const tree = (await (await fetch(`${BASE}/api/projects/${projectId}/tree`)).json()) as {
      nodes: Array<{ id: string; parentId: string | null }>;
    };
    const rootId = tree.nodes.find((n) => n.parentId === null)!.id;
    const codeId = tree.nodes.find((n) => n.parentId !== null)!.id;
    const before = (await (await fetch(`${BASE}/api/nodes/${rootId}`)).json()) as {
      runs: unknown[];
    };
    await session.goto(`${BASE}/?project=${projectId}&node=${rootId}`);
    await session.waitFor("!!document.querySelector('.panel .overflow')");
    await session.click('.panel .overflow');
    await session.eval(
      "Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.includes('Rename')).click()",
    );
    await session.type('.dialog input[aria-label="experiment name"]', 'Starting code');
    await session.click('.dialog .primary');
    await session.waitFor("document.querySelector('.panel h2')?.textContent === 'Starting code'");
    assert.deepEqual(
      ((await (await fetch(`${BASE}/api/nodes/${rootId}`)).json()) as typeof before).runs,
      before.runs,
    );
    const rejected = await fetch(`${BASE}/api/projects/${projectId}/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentId: codeId,
        displayName: 'Stale preview',
        description: 'stale',
        sourceVersion: 'outdated-preview',
      }),
    });
    assert.equal(rejected.status, 412, 'a stale source preview cannot create an experiment');
    const question = (await (
      await fetch(`${BASE}/api/projects/${projectId}/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parentId: codeId,
          displayName: 'Discussion',
          description: 'Why this approach?',
        }),
      })
    ).json()) as { node: { id: string } };
    await fetch(`${BASE}/api/nodes/${question.node.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '?Why this approach?' }),
    });
    await session.waitFor(
      `(async () => (await (await fetch('/api/nodes/${question.node.id}')).json()).node.status === 'ready')()`,
    );
    await session.goto(`${BASE}/?project=${projectId}&node=${question.node.id}`);
    await session.waitFor("!!document.querySelector('.panel-actions .branch-child')");
    await session.click('.panel-actions .branch-child');
    await session.waitFor(
      "document.querySelector('.creation-sources')?.textContent.includes('Named approach')",
    );
    const sources = (await session.eval(
      "document.querySelector('.creation-sources').textContent",
    )) as string;
    assert.match(sources, /Discussion/);
    assert.match(sources, /Named approach/);
    assert.equal(
      await session.eval("document.querySelector('.dialog textarea').placeholder.includes('?')"),
      false,
    );
    await session.type('[aria-label="experiment name"]', 'Next approach');
    await session.type('[aria-label="what should change"]', 'Improve the approach');
    await session.eval(`(() => {
      window.__savedFetch = window.fetch;
      window.fetch = (url, init) => String(url).endsWith('/runs') && init?.method === 'POST'
        ? Promise.resolve(new Response(JSON.stringify({error: 'fixture start failure'}), {status: 503}))
        : window.__savedFetch(url, init);
    })()`);
    await session.click('.dialog-actions .primary');
    await session.waitFor(
      "document.querySelector('.panel h2')?.textContent === 'Next approach' && document.querySelector('.start-error')?.textContent.includes('did not start')",
    );
    assert.equal(
      await session.eval("document.querySelector('.composer textarea').value"),
      'Improve the approach',
    );
    assert.equal(
      await session.eval("document.querySelector('.composer-row button').textContent"),
      'Start first run',
    );
    await session.eval('window.fetch = window.__savedFetch');
    await session.click('.composer-row button');
    await session.waitFor(
      "document.querySelector('.composer-row button').textContent === 'Send' && !document.querySelector('.panel button.stop')",
    );
    const after = (await (
      await fetch(`${BASE}/api/projects/${projectId}/tree`)
    ).json()) as typeof tree;
    assert.equal(after.nodes.length, 4, 'retry starts the existing experiment, not a duplicate');
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-2-panel.png'));
  });

  test('root and multi-run results have distinct changes, visible errors and no implied verdict', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'results',
          description: 'Review all changes',
          location: dataDir,
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const runIds: string[] = [];
    for (const prompt of ['first-change', 'second-change', 'third-change', '?explain the result']) {
      const started = (await (
        await fetch(`${nodeUrl}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
      ).json()) as { runId: string };
      runIds.push(started.runId);
      await session.waitFor(
        `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.status === 'ready')()`,
      );
    }
    const firstResponse = await fetch(`${BASE}/api/runs/${runIds[0]}/diff`);
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as { files: string[] };
    assert.ok(first.files.includes('notes/first-change.md'));
    const second = (await (
      await fetch(`${BASE}/api/runs/${runIds[1]}/diff`)
    ).json()) as typeof first;
    assert.ok(!second.files.includes('notes/first-change.md'));
    const combined = (await (await fetch(`${nodeUrl}/diff`)).json()) as typeof first;
    for (const name of ['first', 'second', 'third'])
      assert.ok(combined.files.includes(`notes/${name}-change.md`));
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.turn-diff-toggle')");
    assert.equal(
      await session.eval(
        "document.querySelector('.panel .st-ready').textContent.includes('Finished')",
      ),
      true,
    );
    assert.equal(
      await session.eval("document.querySelector('.panel .st-ready').textContent.includes('✓')"),
      false,
    );
    await session.eval(`(() => {
      window.__originalFetch = window.fetch;
      window.fetch = (url, init) => String(url).endsWith('/diff')
        ? new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({error: 'fixture diff unavailable'}), {status: 503})), 250))
        : window.__originalFetch(url, init);
    })()`);
    await session.eval(
      "document.querySelector('.turn-diff-toggle').scrollIntoView({ block: 'center' })",
    );
    await session.click('.turn-diff-toggle');
    await session.waitFor(
      "document.querySelector('.turn-diff-toggle').parentElement.textContent.includes('Loading run changes')",
    );
    await session.waitFor(
      "document.querySelector('.panel').textContent.includes('Retry run changes')",
    );
    await session.click('.panel-tabs button:last-child');
    await session.waitFor(
      "document.querySelector('.experiment-changes').textContent.includes('Retry experiment changes')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.results-panel').textContent.includes('No checks recorded for the latest run')",
      ),
      true,
    );
    await session.eval('window.fetch = window.__originalFetch');
    await session.eval(
      "Array.from(document.querySelectorAll('.experiment-changes button')).find(b => b.textContent.includes('Retry experiment')).click()",
    );
    await session.waitFor(
      "document.querySelector('.experiment-changes').textContent.includes('notes/third-change.md')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.comparison-base').textContent.includes('before this experiment')",
      ),
      true,
    );
    await session.eval(
      "Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: () => Promise.reject(new Error('fixture denied'))}})",
    );
    await session.eval(
      "document.querySelector('.results-panel .diff-copy').scrollIntoView({block: 'center'})",
    );
    await session.click('.results-panel .diff-copy');
    await session.waitFor(
      "document.querySelector('.results-panel .diff').textContent.includes('Could not copy the patch')",
    );
    await session.eval('delete navigator.clipboard');
    await session.eval(
      "Array.from(document.querySelectorAll('.results-panel button')).find(b => b.textContent === 'Expand changes').click()",
    );
    await session.waitFor("!!document.querySelector('dialog[open] .dl-number')");
    assert.equal(
      await session.eval(
        "document.querySelector('dialog').getBoundingClientRect().width > document.querySelector('.panel').getBoundingClientRect().width",
      ),
      true,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-3-expanded-changes.png'));
    await session.click('dialog header button');
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-3-results.png'));
    await session.click('.panel-tabs button:first-child');
    await session.eval(
      "Array.from(document.querySelectorAll('.panel button')).find(b => b.textContent === 'Retry run changes').click()",
    );
    await session.waitFor("!!document.querySelector('.turn-diff .diff-file')");
    await session.click('.panel-tabs button:last-child');
    await session.eval(`(() => {
      window.fetch = (url, init) => String(url).endsWith('/diff')
        ? Promise.resolve(new Response(JSON.stringify({ files: [], patch: '', dirty: ['unfinished-new-file.txt'], baseLabel: 'fixture base' })))
        : window.__originalFetch(url, init);
    })()`);
    await session.eval(
      "Array.from(document.querySelectorAll('.experiment-changes button')).find(b => b.textContent === 'Refresh changes').click()",
    );
    await session.waitFor(
      "document.querySelector('.diff-dirty')?.textContent.includes('unfinished-new-file.txt')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.results-panel').textContent.includes('No committed changes in this comparison')",
      ),
      true,
    );
    await session.eval('window.fetch = window.__originalFetch');
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
  test('keeps reading position, reconciles missed history and renders readable output', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reading', description: '', location: dataDir }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const prompt =
      '? Reading fixture\n\n' +
      Array.from(
        { length: 45 },
        (_, i) => `Paragraph ${i}: Keep this reading position while new output arrives.`,
      ).join('\n\n') +
      '\n\n| Check | Result |\n| --- | --- |\n| Example | Passed |\n\n- [x] first\n  - nested\n\n```python\nprint("test")\n```';
    const started = await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    assert.equal(started.status, 202, await started.text());
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor(
      "!!document.querySelector('.turn-foot') && !!document.querySelector('.md-table')",
    );
    await session.waitFor("document.querySelector('.panel-body').scrollTop > 100");
    await session.eval(
      "const region = document.querySelector('.panel-body'); region.scrollTop = 240; region.dispatchEvent(new Event('scroll'));",
    );
    await session.waitFor("!!document.querySelector('.jump-latest')");
    await session.eval(
      `window.__originalFetch = window.fetch; window.__failMessages = false; window.fetch = (url, init) => window.__failMessages && String(url).includes('/messages?') ? Promise.reject(new TypeError('offline fixture')) : window.__originalFetch(url, init);`,
    );
    // A node update refetches both details and history without replacing the transcript.
    await session.eval('window.__failMessages = true');
    await fetch(nodeUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Reading fixture' }),
    });
    await session.waitFor(
      "document.querySelector('.panel').textContent.includes('Showing previously loaded conversation')",
    );
    assert.equal(await session.eval("!!document.querySelector('.md-table')"), true);
    await session.eval('window.__failMessages = false');
    await session.eval(
      "Array.from(document.querySelectorAll('.panel button')).find(b => b.textContent === 'Retry conversation').click()",
    );
    await session.waitFor(
      "!document.querySelector('.panel').textContent.includes('Retry conversation')",
    );
    assert.ok(
      Math.abs(
        Number(await session.eval("document.querySelector('.panel-body').scrollTop")) - 240,
      ) < 5,
    );
    // Switch away and back through real canvas selection.
    const child = (await (
      await fetch(`${BASE}/api/projects/${created.projectId}/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parentId: created.masterNodeId,
          displayName: 'Other reading',
          description: '?',
        }),
      })
    ).json()) as { node: { id: string } };
    await session.waitFor(`!!document.querySelector('[data-id="${child.node.id}"]')`);
    await session.click(`[data-id="${child.node.id}"] .card`);
    await session.waitFor("document.querySelector('.panel h2')?.textContent === 'Other reading'");
    await session.click(`[data-id="${created.masterNodeId}"] .card`);
    await session.waitFor(
      "!!document.querySelector('.md-table') && document.querySelector('.panel-body').scrollTop > 100",
    );
    assert.ok(
      Math.abs(
        Number(await session.eval("document.querySelector('.panel-body').scrollTop")) - 240,
      ) < 5,
    );
    // Capture a subsequent native subscription; drop event delivery to simulate a transport gap.
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__sources = []; const Native = window.EventSource; window.EventSource = class extends Native { constructor(url) { super(url); window.__sources.push(this); } addEventListener(type, listener, options) { super.addEventListener(type, (event) => { if (!window.__dropEvents) listener(event); }, options); } };`,
    });
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor(
      "!!document.querySelector('.health-live') && !!document.querySelector('.md-table')",
    );
    await session.eval(
      "document.querySelector('.panel-body').scrollTop = 240; document.querySelector('.panel-body').dispatchEvent(new Event('scroll')); window.__dropEvents = true; window.__sources.at(-1).dispatchEvent(new Event('error'));",
    );
    await session.waitFor("!!document.querySelector('.health-reconnecting')");
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '? Message written during transport gap' }),
    });
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.status === 'ready')()`,
    );
    await session.eval(
      "window.__dropEvents = false; window.__sources.at(-1).dispatchEvent(new Event('open'));",
    );
    await session.waitFor(
      "document.querySelector('.transcript')?.textContent.includes('Message written during transport gap')",
    );
    assert.equal(await session.eval("document.querySelectorAll('.turn').length"), 2);
    assert.ok(
      Math.abs(
        Number(await session.eval("document.querySelector('.panel-body').scrollTop")) - 240,
      ) < 5,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-4-reading.png'));
    await session.click('.jump-latest');
    await session.waitFor(
      "document.querySelector('.panel-body').scrollHeight - document.querySelector('.panel-body').scrollTop - document.querySelector('.panel-body').clientHeight < 5",
    );
    await session.eval(
      "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('clipboard fixture')) } }); document.querySelector('.code-actions button').click()",
    );
    await session.waitFor(
      "document.querySelector('.code-actions').textContent.includes('Copy failed')",
    );
    await session.eval('delete navigator.clipboard');
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-4-topbar.png'));
    // Chromium's real offline mode drops the SSE connection and HTTP requests.
    await session.send('Network.enable', {});
    try {
      await session.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await session.waitFor("!!document.querySelector('.health-reconnecting')");
      assert.equal(await session.eval("document.querySelectorAll('.turn').length"), 2);
      await fetch(`${nodeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '? Written while browser offline' }),
      });
      for (let i = 0; i < 100; i += 1) {
        const current = (await (await fetch(nodeUrl)).json()) as { node: { status: string } };
        if (current.node.status === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await session.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    }
    await session.waitFor(
      "!!document.querySelector('.health-live') && document.querySelectorAll('.turn').length === 3",
    );
  });

  test('queued and permission jobs share stop controls and question drafts stay scoped', async () => {
    await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentRuns: 1 }),
    });
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'permissions',
          description: '',
          location: dataDir,
          permissionMode: 'default',
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const queued = (await (
      await fetch(`${BASE}/api/projects/${created.projectId}/nodes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parentId: created.masterNodeId,
          displayName: 'Queued experiment',
          description: 'queued request',
        }),
      })
    ).json()) as { node: { id: string } };
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'permission fixture' }),
    });
    await fetch(`${BASE}/api/nodes/${queued.node.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'queued fixture' }),
    });
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor(
      "!!document.querySelector('.ask input') && document.querySelector('.stop-all')?.textContent.includes('2 runs')",
    );
    assert.equal(await session.eval("!!document.querySelector('.composer-row')"), false);
    assert.equal(
      await session.eval(`!!document.querySelector('[data-id="${queued.node.id}"] .stop')`),
      true,
    );
    await session.type('.ask input', 'This reason belongs only to the first question');
    await session.eval(
      "window.__originalFetch = window.fetch; window.fetch = (url, init) => String(url).endsWith('/cancel') ? Promise.resolve(new Response(JSON.stringify({ error: 'Stop failed fixture' }), { status: 503 })) : window.__originalFetch(url, init);",
    );
    await session.click('.panel .stop');
    await session.waitFor(
      "document.querySelector('.panel .stop-error')?.textContent.includes('Stop failed fixture')",
    );
    assert.equal(await session.eval("document.querySelector('.panel .stop').disabled"), false);
    await session.eval('window.fetch = window.__originalFetch');
    await session.click(`[data-id="${queued.node.id}"] .stop`);
    await session.waitFor(`!document.querySelector('[data-id="${queued.node.id}"] .stop')`);
    // Freeze the browser's tree snapshot while another window answers the same question.
    const tree = (await (await fetch(`${BASE}/api/projects/${created.projectId}/tree`)).json()) as {
      nodes: Array<{ id: string; pendingQuestion: { id: string } | null }>;
    };
    const questionId = tree.nodes.find((n) => n.id === created.masterNodeId)!.pendingQuestion!.id;
    await session.eval(
      `window.fetch = (url, init) => String(url).endsWith('/tree') ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(tree))})) : window.__originalFetch(url, init);`,
    );
    await fetch(`${BASE}/api/questions/${questionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: false, message: 'Answered elsewhere' }),
    });
    await session.click('.ask-actions button:first-child');
    await session.waitFor(
      "document.querySelector('.panel-foot')?.textContent.includes('already answered')",
    );
    await session.eval('window.fetch = window.__originalFetch');
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.status === 'ready')()`,
    );
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'second permission' }),
    });
    await session.waitFor(
      "!!document.querySelector('.ask input') && document.querySelector('.ask input').value === ''",
    );
    await session.waitFor("!document.querySelector('.panel .stop-error')");
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-4-permission.png'));
    await fetch(`${BASE}/api/nodes/${queued.node.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'queued again' }),
    });
    await session.waitFor("document.querySelector('.stop-all')?.textContent.includes('2 runs')");
    await session.eval(
      "window.fetch = (url, init) => String(url).endsWith('/cancel') ? new Promise(resolve => setTimeout(() => resolve(window.__originalFetch(url, init)), 250)) : window.__originalFetch(url, init);",
    );
    await session.click('.stop-all');
    assert.equal(await session.eval("document.querySelector('.stop-all').disabled"), true);
    await session.waitFor(
      "!document.querySelector('.ask') && !document.querySelector('.panel .stop') && !document.querySelector('.stop-all')",
    );
    await session.eval('window.fetch = window.__originalFetch');
    const queuedDetail = (await (await fetch(`${BASE}/api/nodes/${queued.node.id}`)).json()) as {
      runs: Array<{ status: string }>;
    };
    assert.equal(queuedDetail.runs.at(-1)?.status, 'cancelled');
    const detail = (await (await fetch(nodeUrl)).json()) as { runs: Array<{ status: string }> };
    assert.equal(detail.runs.at(-1)?.status, 'cancelled');
  });
  test('initial connection and project failures offer retry instead of an empty canvas', async () => {
    const script = (await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__failConnection = true; window.__failProjects = true; const nativeFetch = window.fetch; window.fetch = (url, init) => (window.__failConnection && String(url) === '/api/connection') || (window.__failProjects && String(url) === '/api/projects') ? Promise.resolve(new Response(JSON.stringify({ error: 'Unavailable fixture' }), { status: 503 })) : nativeFetch(url, init);`,
    })) as { result: { identifier: string } };
    try {
      await session.goto(BASE);
      await session.waitFor(
        "document.querySelector('.connect')?.textContent.includes('Unavailable fixture')",
      );
      assert.equal(await session.eval("!!document.querySelector('.react-flow')"), false);
      await session.eval(
        "window.__failConnection = false; document.querySelector('.connect button').click()",
      );
      await session.waitFor(
        "document.querySelector('.tree-notice')?.textContent.includes('Unavailable fixture')",
      );
      await session.eval(
        "window.__failProjects = false; document.querySelector('.tree-notice button').click()",
      );
      await session.waitFor(
        "!!document.querySelector('.card') && !document.querySelector('.tree-notice')",
      );
      // A narrow canvas still keeps its project menu, server health and settings available.
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 1100,
        height: 780,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await session.eval(
          "(() => { const bar = document.querySelector('.menubar').getBoundingClientRect(); return ['.project-picker', '.server-health', '.settings-button'].every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.width > 0 && r.left >= bar.left && r.right <= bar.right; }); })()",
        ),
        true,
      );
      await session.screenshot(join(repoRoot, 'test-results', 'milestone-4-narrow-topbar.png'));
    } finally {
      await session.send('Emulation.clearDeviceMetricsOverride', {});
      await session.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script.result.identifier,
      });
    }
  });
  test('settings save by scope, diagnostics preview and usage stay reviewable without agent access', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'controls',
          description: 'settings review',
          location: dataDir,
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const projectUrl = `${BASE}/api/projects/${created.projectId}`;
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const rejected = await fetch(projectUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'should-not-save', copyFiles: ['../outside'] }),
    });
    assert.equal(rejected.status, 400);
    const untouched = (await (await fetch(`${projectUrl}/tree`)).json()) as {
      project: { defaultModel: string | null; setup: { copyFiles: string[] } };
    };
    assert.notEqual(untouched.project.defaultModel, 'should-not-save');
    assert.deepEqual(untouched.project.setup.copyFiles, []);
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.composer textarea')");
    await session.click('.settings-button');
    await session.waitFor("!!document.querySelector('dialog.settings-dialog[open]')");
    await session.click('.settings-tabs button:nth-child(2)');
    await session.eval(
      "window.__originalFetch = window.fetch; window.__failSave = true; window.fetch = (url, init) => window.__failSave && init?.method === 'PATCH' ? Promise.reject(new TypeError('save fixture offline')) : window.__originalFetch(url, init)",
    );
    await session.eval(
      "const effort = document.querySelector('.project-agent select[aria-label=Effort]'); effort.value = 'low'; effort.dispatchEvent(new Event('change', {bubbles: true}));",
    );
    await session.click('.project-agent button');
    await session.waitFor(
      "document.querySelector('.project-agent').textContent.includes('Could not confirm save')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.project-agent select[aria-label=Effort]').value",
      ),
      'low',
    );
    await session.eval('window.__failSave = false');
    await session.click('.project-agent button');
    await session.waitFor(
      "document.querySelector('.project-agent .save-feedback').textContent === 'Saved'",
    );
    const detail = (await (await fetch(nodeUrl)).json()) as {
      nextRunSettings: { effort: string; effortSource: string };
    };
    assert.equal(detail.nextRunSettings.effort, 'low');
    assert.equal(detail.nextRunSettings.effortSource, 'project');
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-5-project-settings.png'));
    await session.click('.settings-tabs button:nth-child(3)');
    await session.eval(
      'window.__copiedReport = null; navigator.clipboard.writeText = async (text) => { window.__copiedReport = text; }',
    );
    await session.click('.diagnostics > button');
    await session.waitFor(
      '!!document.querySelector(\'textarea[aria-label="Diagnostics preview"]\')',
    );
    assert.equal(
      await session.eval('window.__copiedReport'),
      null,
      'generate never writes clipboard',
    );
    await session.eval(
      "document.querySelector('.diagnostics .save-row button').scrollIntoView({block:'center'})",
    );
    await session.click('.diagnostics .save-row button');
    await session.waitFor(
      "window.__copiedReport === document.querySelector('.diagnostics textarea').value",
    );
    const report = JSON.parse(String(await session.eval('window.__copiedReport'))) as {
      node: { displayName: string };
    };
    assert.equal(report.node.displayName, '[omitted]');
    await session.eval(
      "navigator.clipboard.writeText = async () => { throw new Error('clipboard fixture'); }",
    );
    await session.click('.diagnostics .save-row button');
    await session.waitFor(
      "document.querySelector('.diagnostics').textContent.includes('Copy failed')",
    );
    assert.equal(
      await session.eval("document.querySelector('.diagnostics textarea').value"),
      JSON.stringify(report, null, 2),
    );

    await session.eval('document.querySelector(\'[aria-label="Close settings"]\').click()');
    await session.waitFor("!document.querySelector('dialog.settings-dialog')");
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '? saved history for offline review' }),
    });
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).runs.at(-1)?.status === 'done')()`,
    );
    await session.click('.usage-button');
    await session.waitFor("!!document.querySelector('.usage-totals')");
    assert.equal(
      await session.eval(
        "document.querySelector('.usage-totals > div:nth-child(2) strong').textContent",
      ),
      '1',
    );
    assert.equal(
      await session.eval("document.querySelectorAll('.card .cost, .project-cost').length"),
      0,
    );
    await session.click('.usage-experiment summary');
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-5-usage.png'));
    await session.click('[aria-label="Close usage"]');
    // On reload, the server still serves saved data but reports an expired credential.
    const script = (await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__offlineAgent = true; const nativeFetch = window.fetch; window.fetch = (url, init) => window.__offlineAgent && String(url).endsWith('/connection') ? Promise.resolve(new Response(JSON.stringify({state:'no_credential', model:null, apiKeySource:null, message:'Expired credential fixture'}), {headers:{'content-type':'application/json'}})) : nativeFetch(url, init);`,
    })) as { result: { identifier: string } };
    try {
      await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
      await session.waitFor(
        "document.querySelectorAll('.turn').length === 1 && document.body.textContent.includes('Agent unavailable')",
      );
      await session.type('.composer textarea', 'keep this draft');
      assert.equal(
        await session.eval("document.querySelector('.composer-row button').disabled"),
        true,
      );
      await session.click('.usage-button');
      await session.waitFor("!!document.querySelector('.usage-totals')");
      await session.click('[aria-label="Close usage"]');
      await session.click('.settings-button');
      await session.waitFor("document.querySelector('.connection-settings')?.open === true");
      await session.eval('window.__offlineAgent = false');
      await session.eval(
        "Array.from(document.querySelectorAll('.connection-settings button')).find(b => b.textContent === 'Recheck').click()",
      );
      await session.waitFor("!document.body.textContent.includes('Agent unavailable')");
      await session.click('[aria-label="Close settings"]');
      assert.equal(
        await session.eval("document.querySelector('.composer textarea').value"),
        'keep this draft',
      );
      assert.equal(
        await session.eval("document.querySelector('.composer-row button').disabled"),
        false,
      );
    } finally {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script.result.identifier,
      });
    }
    await session.click('.project-picker');
    await session.eval(
      "Array.from(document.querySelectorAll('.menu-panel button')).find(b => b.textContent.includes('Delete this project')).click()",
    );
    await session.waitFor("!!document.querySelector('dialog.confirm[open]')");
    assert.equal(await session.eval('document.activeElement.textContent'), 'Cancel');
    assert.equal(
      await session.eval(
        "document.querySelector('dialog.confirm').textContent.includes('deleted from disk')",
      ),
      true,
    );
    assert.equal(
      await session.eval("document.querySelector('dialog.confirm button.destructive').disabled"),
      true,
    );
    for (let i = 0; i < 5; i += 1) {
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      assert.equal(
        await session.eval(
          "document.querySelector('dialog.confirm').contains(document.activeElement)",
        ),
        true,
      );
    }
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-5-confirm.png'));
    await session.click('dialog.confirm .dialog-actions button:first-child');
    assert.equal((await fetch(`${projectUrl}/tree`)).status, 200, 'Cancel keeps the project');
    const storageRoot = join(dataDir, 'future-storage');
    const saved = await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reposRoot: storageRoot }),
    });
    assert.equal(saved.status, 200);
    const future = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'future-location', description: '', location: dataDir }),
      })
    ).json()) as { projectId: string };
    assert.equal(existsSync(join(storageRoot, future.projectId, 'repo.git')), true);
    const priorImpact = (await (await fetch(`${projectUrl}/deletion-impact`)).json()) as {
      removesDirectories: string[];
    };
    assert.ok(priorImpact.removesDirectories.includes(join(dataDir, 'repos', created.projectId)));
    assert.ok(!priorImpact.removesDirectories.some((path) => path.startsWith(storageRoot)));
  });
  test('visual workspace supports text sizing, keyboard branching, stable zoom and narrow views', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'visual-review',
          description: 'A long experiment description for comfortable reading.',
          location: dataDir,
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor(
      "!!document.querySelector('.branch-child') && !!document.querySelector('.card')",
    );
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.waitFor(
      "document.querySelector('.composer textarea').getBoundingClientRect().bottom < 721",
    );
    assert.ok(
      Number(await session.eval('parseFloat(getComputedStyle(document.body).fontSize)')) >= 14.5,
    );
    // Pin and unpin using the existing server-owned positioning API.
    await fetch(nodeUrl, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positionX: 120, positionY: 150 }),
    });
    await session.waitFor(
      "Array.from(document.querySelectorAll('.canvas-tools button')).some(b => b.textContent === 'Automatic position')",
    );
    await session.eval(
      "Array.from(document.querySelectorAll('.canvas-tools button')).find(b => b.textContent === 'Automatic position').click()",
    );
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.positionX === null)()`,
    );
    await session.type('.composer textarea', 'Retain this draft across views');
    await session.click('.branch-child');
    await session.waitFor(
      "document.activeElement?.getAttribute('aria-label') === 'experiment name'",
    );
    await session.type('[aria-label="experiment name"]', 'Keyboard experiment');
    await session.type('[aria-label="what should change"]', 'A multiline request');
    await session.eval(
      "document.querySelector('[aria-label=\"what should change\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))",
    );
    assert.equal(
      await session.eval('!!document.querySelector(\'dialog[aria-label="Branch experiment"]\')'),
      true,
      'IME composition does not submit',
    );
    for (let i = 0; i < 14; i++) {
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
      });
      assert.equal(
        await session.eval("document.querySelector('dialog').contains(document.activeElement)"),
        true,
      );
    }
    // A backdrop click cannot discard this form.
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 2,
      y: 2,
      button: 'left',
      clickCount: 1,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 2,
      y: 2,
      button: 'left',
      clickCount: 1,
    });
    assert.equal(
      await session.eval('document.querySelector(\'[aria-label="experiment name"]\').value'),
      'Keyboard experiment',
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-branch-1280.png'));
    await session.eval(
      "Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click()",
    );
    await session.waitFor("document.activeElement?.classList.contains('branch-child')");
    const zoom = await session.eval(
      "document.querySelector('.react-flow__viewport').style.transform.match(/scale\\(([^)]+)\\)/)[1]",
    );
    await fetch(`${BASE}/api/projects/${created.projectId}/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentId: created.masterNodeId,
        displayName: 'Background experiment',
        description: '',
      }),
    });
    await session.waitFor("document.querySelectorAll('.card').length === 2");
    assert.equal(
      await session.eval(
        "document.querySelector('.react-flow__viewport').style.transform.match(/scale\\(([^)]+)\\)/)[1]",
      ),
      zoom,
      'background growth does not refit',
    );
    // Wide: collapsing the panel must leave a control that DOES something. The
    // segmented switch used to render here with Map pressed and inert.
    await session.click('.hide-panel');
    await session.waitFor(
      "document.querySelector('.app').classList.contains('panel-hidden') && document.querySelectorAll('.view-switch button').length === 1",
    );
    assert.equal(
      await session.eval("document.querySelector('.view-switch button').textContent"),
      'Show experiment',
    );
    // A collapsed panel stays collapsed when another experiment is chosen: a
    // collapse that reopens on the next click is not a collapse.
    await session.click('.react-flow__node:last-child');
    assert.equal(
      await session.eval("document.querySelector('.app').classList.contains('panel-hidden')"),
      true,
    );
    await session.click('.view-switch button');
    await session.waitFor("!document.querySelector('.app').classList.contains('panel-hidden')");
    // Back to master, whose draft the narrow checks below follow across views.
    await session.click('.react-flow__node:first-child');
    await session.waitFor("document.querySelector('.panel h2')?.textContent === 'master'");
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-map-1280.png'));
    const contrast = await session.eval(`(() => {
      const rgb = s => s.match(/[\\d.]+/g).slice(0,3).map(Number);
      const luminance = c => c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const ratio = (a,b) => { const x=luminance(rgb(a)), y=luminance(rgb(b)); return Math.round((Math.max(x,y)+.05)/(Math.min(x,y)+.05)*100)/100; };
      const results = [];
      for (const selector of ['.composer textarea', '.composer .hint', '.composer-row button', '.branch-child', '.card-name', '.chip']) {
        const el=document.querySelector(selector), style=getComputedStyle(el);
        let parent=el, bg='rgb(13, 14, 17)';
        while(parent) { const candidate=getComputedStyle(parent).backgroundColor; if(candidate.startsWith('rgb(')) {bg=candidate;break;} parent=parent.parentElement; }
        results.push({selector, color:style.color, background:bg, ratio:ratio(style.color,bg)});
      }
      return results;
    })()`);
    await writeFile(
      join(repoRoot, 'test-results', 'milestone-6-contrast.json'),
      JSON.stringify(contrast, null, 2),
    );
    for (const pair of contrast as Array<{ selector: string; ratio: number }>)
      assert.ok(pair.ratio >= 4.5, pair.selector);
    await session.click('.settings-button');
    await session.waitFor('!!document.querySelector(\'[aria-label="Text size"]\')');
    await session.eval(
      "const input = document.querySelector('[aria-label=\"Text size\"]'); input.value='130'; input.dispatchEvent(new Event('change',{bubbles:true}));",
    );
    await session.click('.appearance-settings button');
    await session.waitFor(
      "document.querySelector('.appearance-settings .save-feedback').textContent === 'Saved' && parseFloat(getComputedStyle(document.body).fontSize) > 18",
    );
    await session.click('[aria-label="Close settings"]');
    // A transcript worth scrolling, so the reading-position check below cannot
    // pass by having nothing to scroll. One turn per run, so two runs.
    for (const prompt of [
      'Write a first pass worth scrolling through.',
      'Now extend it so the conversation is longer than the panel.',
    ]) {
      await fetch(`${BASE}/api/nodes/${created.masterNodeId}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      // Started, then finished. Counting turns instead would race: the second
      // run's POST returns before the interface has heard about it, and the
      // turn count from the first run already satisfies the target.
      await session.waitFor("!!document.querySelector('.panel button.stop')", {
        timeoutMs: 20000,
      });
      await session.waitFor("!document.querySelector('.panel button.stop')", { timeoutMs: 20000 });
    }
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await session.eval("getComputedStyle(document.querySelector('.canvas')).display"),
      'none',
    );
    assert.ok(
      Number(
        await session.eval("document.querySelector('.panel').getBoundingClientRect().width"),
      ) <= 800,
    );
    // Waited for rather than asserted outright: the assertion is about the
    // settled layout, and a viewport change has not reflowed on the next tick.
    await session.waitFor(
      "document.querySelector('.composer-row button').getBoundingClientRect().bottom <= 720",
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-800-large.png'));
    // Narrow: one view at a time, chosen with a two-state segmented switch.
    assert.equal(await session.eval("document.querySelectorAll('.view-switch button').length"), 2);
    await session.click('.view-switch button:first-child');
    assert.equal(
      await session.eval("getComputedStyle(document.querySelector('.panel')).display"),
      'none',
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.view-switch button:first-child').getAttribute('aria-pressed')",
      ),
      'true',
    );
    /**
     * The canvas viewport survives the round trip.
     *
     * The hidden view stays mounted rather than being unmounted, so switching
     * away and back must not re-fit the tree or lose where the user had panned
     * to. React Flow keeps its transform in its own store; this asserts that
     * losing and regaining a layout box does not disturb it.
     */
    const parked = await session.eval(
      "document.querySelector('.react-flow__viewport').style.transform",
    );
    await session.click('.view-switch button:last-child');
    await session.click('.view-switch button:first-child');
    assert.equal(
      await session.eval("document.querySelector('.react-flow__viewport').style.transform"),
      parked,
      'switching views preserves the canvas viewport',
    );
    await session.click('.view-switch button:last-child');
    assert.equal(
      await session.eval("document.querySelector('.composer textarea').value"),
      'Retain this draft across views',
    );
    // And the reading position, which a hidden element loses on its own: a
    // scroll offset does not survive losing a layout box.
    const scrolled = Number(
      await session.eval(
        "const b=document.querySelector('.panel-body:not([hidden])'); b.scrollTop = Math.max(1, b.scrollHeight - b.clientHeight); b.dispatchEvent(new Event('scroll')); b.scrollTop",
      ),
    );
    assert.ok(scrolled > 0, 'the fixture must actually overflow for this to mean anything');
    await session.click('.view-switch button:first-child');
    await session.click('.view-switch button:last-child');
    await session.waitFor(
      `document.querySelector('.panel-body:not([hidden])').scrollTop === ${scrolled}`,
    );
    for (const width of [640, 480]) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await session.eval('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
      );
      assert.ok(
        Number(
          await session.eval(
            "document.querySelector('.branch-child').getBoundingClientRect().right",
          ),
        ) <= width,
      );
      await session.screenshot(join(repoRoot, 'test-results', `milestone-6-${width}-large.png`));
    }
    // 1280×720 at 200% browser zoom has a 640×360 CSS viewport.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 360,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await session.eval('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
    );
    assert.ok(Number(await session.eval("document.querySelector('.panel-body').clientHeight")) > 0);
    await session.eval(
      "document.querySelector('.composer-row button').scrollIntoView({block:'nearest'})",
    );
    assert.ok(
      Number(
        await session.eval(
          "document.querySelector('.composer-row button').getBoundingClientRect().bottom",
        ),
      ) <= 361,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-zoom-200.png'));
    await session.click('.view-switch button:first-child');
    await session.click('.settings-button');
    await session.click('[aria-label="Close settings"]');
    await session.send('Emulation.clearDeviceMetricsOverride', {});
    await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ textScale: 100 }),
    });
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
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
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
