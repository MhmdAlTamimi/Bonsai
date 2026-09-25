import { git } from './git/exec.js';
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLeftovers } from './jobs/leftovers.js';

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
          // Long enough that a stand-in background job is still running
          // whenever a test looks; each test ends it with Finish now or Stop.
          BONSAI_FAKE_BACKGROUND_MS: '60000',
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
      t.diagnostic(
        JSON.stringify(
          await session.eval(
            "(async () => { const id = new URL(location.href).searchParams.get('node'); if (!id) return null; const d = await (await fetch('/api/nodes/' + id)).json(); return {status: d.node?.status, activity: d.node?.activity, lastRun: d.runs?.at(-1)?.status}; })()",
          ),
        ),
      );
    }
  });

  afterEach(async () => {
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string }>;
    for (const project of projects) {
      const tree = (await (await fetch(`${BASE}/api/projects/${project.id}/tree`)).json()) as {
        nodes: Array<{ id: string; status: string }>;
      };
      for (const node of tree.nodes ?? []) {
        if (node.status === 'running' || node.status === 'needs_you')
          await fetch(`${BASE}/api/nodes/${node.id}/cancel`, { method: 'POST' });
      }
    }
    await fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentRuns: 3 }),
    });
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
        "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Choose folder…').click()",
      );
      await session.waitFor(
        "!!document.querySelector('.picker input') && !document.querySelector('.picker > button').disabled",
      );
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
      await session.click('.composer-row button.primary');
      await session.waitFor(
        "!document.querySelector('.panel button.stop') && document.querySelector('.composer-row .send-label')?.textContent === 'Send'",
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
    await session.click('.composer-row button.primary');
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
    // Renaming lives on the card's own menu now: it is a property of the node
    // on the map, not of whichever node the panel happens to be showing.
    await session.waitFor(`!!document.querySelector('[data-id="${rootId}"] .card-more')`);
    await session.click(`[data-id="${rootId}"] .card-more`);
    await session.eval(
      "Array.from(document.querySelectorAll('.card-menu [role=menuitem]')).find(b => b.textContent.includes('Rename')).click()",
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
    // Branching is a canvas action now: it creates a node, so it lives on the
    // card, not in the reply row where it competed with Send.
    assert.equal(await session.eval("!!document.querySelector('.composer-row .secondary')"), false);
    await session.click(`[data-id="${question.node.id}"] .card-more`);
    await session.eval(
      "Array.from(document.querySelectorAll('.card-menu [role=menuitem]')).find(b => b.textContent.includes('Branch child')).click()",
    );
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
      await session.eval("document.querySelector('.composer-row .send-label').textContent"),
      'Start first run',
    );
    await session.eval('window.fetch = window.__savedFetch');
    await session.click('.composer-row button.primary');
    await session.waitFor(
      "document.querySelector('.composer-row .send-label').textContent === 'Send' && !document.querySelector('.panel button.stop')",
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
    for (const prompt of [
      'first-change',
      'second-change',
      'tools: third-change',
      '?explain the result',
    ]) {
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
    for (const name of ['first-change', 'second-change', 'tools-third-change'])
      assert.ok(combined.files.includes(`notes/${name}.md`));
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.run-foot')");

    // The panel says who it is and how it ended, without a word of verdict.
    assert.equal(
      await session.eval(
        `document.querySelector('[data-id="${created.masterNodeId}"] .chip').textContent`,
      ),
      'Finished',
    );
    assert.equal(
      await session.eval("document.querySelector('.panel-head .run-count').textContent"),
      '4 runs',
    );
    assert.equal(
      await session.eval("document.querySelector('.panel').textContent.includes('✓')"),
      false,
    );

    /*
     * What the agent did is in the conversation: an EDIT block with the file
     * it wrote and the lines it added. The whole diff is not repeated here.
     */
    await session.waitFor("!!document.querySelector('.tool-block')");
    assert.equal(
      await session.eval("document.querySelector('.tool-block .tool-kind').textContent"),
      'EDIT',
    );
    assert.equal(
      await session.eval(
        "Array.from(document.querySelectorAll('.tool-block')).some(b => b.textContent.includes('third-change') && b.querySelector('.dl-add'))",
      ),
      true,
    );

    /*
     * Three kinds of block, one shell. A READ is its header alone; a RUN shows
     * the END of its output, eight lines of it, with the rest one disclosure
     * away; an EDIT shows the lines that moved. Every one of them can be
     * copied, and none of them scrolls.
     */
    const kinds = (await session.eval(
      "JSON.stringify(Array.from(document.querySelectorAll('.tool-block .tool-kind')).map(k => k.textContent))",
    )) as string;
    for (const kind of ['READ', 'RUN', 'EDIT']) assert.match(kinds, new RegExp(kind));
    assert.equal(
      await session.eval("!!document.querySelector('.kind-read .tool-body')"),
      false,
      'a read has no output worth a body',
    );
    assert.equal(
      await session.eval("document.querySelectorAll('.kind-run .tool-line').length"),
      8,
      'eight lines, then the disclosure',
    );
    assert.equal(
      await session.eval("document.querySelector('.kind-run .tool-line .tool-text').textContent"),
      'processed document 13',
      'the END of the output: how a command finished is what was asked',
    );
    assert.equal(
      await session.eval(
        "Array.from(document.querySelectorAll('.tool-block')).every(b => b.scrollHeight <= b.clientHeight + 1)",
      ),
      true,
      'no block scrolls on its own',
    );
    await session.eval("document.querySelector('.kind-run').scrollIntoView({ block: 'center' })");
    await session.click('.kind-run .disclosure-row');
    await session.waitFor("document.querySelectorAll('.kind-run .tool-line').length === 20");
    assert.match(
      String(await session.eval("document.querySelector('.kind-run .disclosure-row').textContent")),
      /Hide 12 lines/,
    );
    await session.eval(
      "document.querySelector('.kind-run .disclosure-row').scrollIntoView({ block: 'center' })",
    );
    await session.click('.kind-run .disclosure-row');
    await session.waitFor("document.querySelectorAll('.kind-run .tool-line').length === 8");

    // Copy is always there, and says so when the clipboard refuses.
    await session.eval(
      "window.__copied = null; Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async (t) => { window.__copied = t; }}})",
    );
    await session.eval("document.querySelector('.kind-run').scrollIntoView({ block: 'center' })");
    await session.click('.kind-run .tool-copy');
    await session.waitFor("window.__copied === 'python run_experiment.py --bucket kb-raw'", {
      label: 'the command to be copied — never its output',
    });
    await session.eval(
      "Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: () => Promise.reject(new Error('fixture denied'))}})",
    );
    await session.eval("document.querySelector('.kind-edit').scrollIntoView({ block: 'center' })");
    await session.click('.kind-edit .tool-copy');
    await session.waitFor(
      "document.querySelector('.kind-edit .tool-copy.failed')?.textContent.includes('Copy failed')",
      { label: 'a refused copy to say so' },
    );
    await session.eval('delete navigator.clipboard');

    await session.screenshot(join(repoRoot, 'test-results', 'milestone-8-conversation.png'));

    /*
     * Nothing about the experiment's FILES or its node facts is in the panel:
     * the change is read on the review screen, and the facts are in the card's
     * ⋯ menu. The panel is the conversation and nothing else.
     */
    assert.equal(
      await session.eval(
        "!!document.querySelector('.result-details, .experiment-changes, .next-run, .checkout-section, .lineage')",
      ),
      false,
    );
    await session.click(`[data-id="${created.masterNodeId}"] .card-more`);
    await session.eval(
      "Array.from(document.querySelectorAll('.card-menu [role=menuitem]')).find(b => b.textContent.includes('Experiment details')).click()",
    );
    await session.waitFor("!!document.querySelector('.dialog .facts')", {
      label: 'the experiment details dialog',
    });
    const facts = String(await session.eval("document.querySelector('.dialog').textContent"));
    assert.match(facts, /node id/);
    assert.match(facts, /Goal/);
    await session.click('.dialog .dialog-actions button');
    await session.waitFor("!document.querySelector('.dialog')");

    // Settings for a run that has not happened are behind the composer's ⋯.
    await session.click('.composer-more');
    await session.waitFor(
      "document.querySelector('.menu-panel.next-run')?.textContent.includes('Permissions')",
    );
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
    });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await session.waitFor("!document.querySelector('.menu-panel.next-run')");
  });

  test('review reads an experiment’s changes: a tree, a diff, split and back', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'review',
          description: 'reviewing changes',
          location: dataDir,
          permissionMode: 'acceptEdits',
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    for (const prompt of ['first change', 'second change']) {
      await fetch(`${nodeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      await session.waitFor(
        `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.status === 'ready')()`,
      );
    }

    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.panel h2')");

    // Reading the change starts from the card: the change summary in its foot
    // IS the way in, and the same thing sits in its ⋯ menu.
    await session.click(`[data-id="${created.masterNodeId}"] .review-control`);
    await session.waitFor("!!document.querySelector('.review .tree-row.file')", {
      label: 'the review screen',
    });

    // The list is files with a status letter, and the first one is already open.
    assert.match(
      String(await session.eval("document.querySelector('.tree-totals').textContent")),
      /3 files/,
    );
    assert.equal(await session.eval("document.querySelectorAll('.tree-row.file').length"), 3);
    await session.waitFor("!!document.querySelector('.diff-line')");
    assert.equal(
      await session.eval("!!document.querySelector('.tree-row.selected .row-cap')"),
      true,
      'the open file is marked in the tree',
    );
    assert.equal(
      await session.eval("!!document.querySelector('.guide.live, .caret.live')"),
      true,
      'its ancestors are lit',
    );

    // Another file loads into the pane.
    await session.eval(
      "Array.from(document.querySelectorAll('.tree-row.file')).find(r => r.textContent.includes('second-change')).click()",
    );
    await session.waitFor(
      "document.querySelector('.file-identity')?.textContent.includes('second-change')",
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-8-review.png'));

    // Filtering, and `/` to reach it without the mouse.
    await session.type('.tree-filter input', 'CONTEXT');
    await session.waitFor("document.querySelectorAll('.tree-row.file').length === 1");
    await session.type('.tree-filter input', '');
    await session.waitFor("document.querySelectorAll('.tree-row.file').length === 3");
    await session.eval("document.querySelector('.review').focus()");
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', text: '/' });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/' });
    assert.equal(
      await session.eval("document.activeElement === document.querySelector('.tree-filter input')"),
      true,
    );

    // Whole-file reading and wrapping use the same review, with a persisted preference.
    await session.eval(
      "Array.from(document.querySelectorAll('.review-bar button')).find(b=>b.getAttribute('aria-label')==='File').click()",
    );
    await session.waitFor(
      "!!document.querySelector('.diff-line') && !document.querySelector('.hunk')",
    );
    await session.eval(
      "Array.from(document.querySelectorAll('.review-bar button')).find(b=>b.getAttribute('aria-label')==='Wrap lines').click()",
    );
    await session.waitFor("document.querySelector('.review').classList.contains('wrap-lines')");
    assert.equal(
      ((await (await fetch(`${BASE}/api/settings`)).json()) as { wrapLines: boolean }).wrapLines,
      true,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'phases-1-file-review.png'));
    await session.eval(
      "Array.from(document.querySelectorAll('.review-bar button')).find(b=>b.getAttribute('aria-label')==='Diff').click()",
    );
    await session.waitFor("!!document.querySelector('.hunk')");

    // Two files side by side, the focused one marked, then back to one.
    await session.eval("document.querySelectorAll('.view-toggle button')[1].click()");
    await session.waitFor("document.querySelectorAll('.diff-pane').length === 2");
    assert.equal(
      await session.eval(
        "new Set(Array.from(document.querySelectorAll('.pane-header .path-name')).map(e => e.textContent)).size",
      ),
      2,
      'a comparison, not the same file twice',
    );
    assert.equal(await session.eval("!!document.querySelector('.diff-pane.focused')"), true);
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-8-review-split.png'));
    await session.eval("document.querySelectorAll('.view-toggle button')[0].click()");
    await session.waitFor("document.querySelectorAll('.diff-pane').length === 1");

    // The tree is resizable, and stays readable however far it is dragged.
    const width = () =>
      session.eval("document.querySelector('.tree-column').getBoundingClientRect().width");
    assert.equal(await width(), 272);
    await session.dragTo('.review-body .grip', { x: 5, y: 400 });
    assert.equal(await width(), 200, 'never narrower than its paths');

    /*
     * The conversation's width is a property of what you are doing: review
     * opens with it collapsed to the rail, ⌘\ brings it back at three
     * quarters of the canvas width, and coming back to review remembers that.
     */
    assert.equal(
      await session.eval("!!document.querySelector('.conversation-rail')"),
      true,
      'review opens with the conversation collapsed',
    );
    assert.equal(await session.eval("document.querySelector('.panel').offsetWidth"), 0);
    for (const type of ['keyDown', 'keyUp'])
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: '\\',
        code: 'Backslash',
        modifiers: 4,
      });
    await session.waitFor("document.querySelector('.panel').offsetWidth === 285", {
      label: 'the conversation at its review width',
    });
    assert.equal(await session.eval("!!document.querySelector('.conversation-rail')"), false);

    // Esc goes back to the map, which kept its place.
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
    });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await session.waitFor(
      "!document.querySelector('.review') && !!document.querySelector('.card')",
    );

    // ⏎ on a focused experiment opens the same screen.
    await session.eval("document.querySelector('.react-flow__node').focus()");
    for (const type of ['keyDown', 'keyUp'])
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
    await session.waitFor("!!document.querySelector('.review .tree-row')");
    await session.waitFor("document.querySelector('.panel').offsetWidth === 285", {
      label: 'review to remember that the conversation was opened',
    });
    await session.click('.review .back');
    await session.waitFor("!document.querySelector('.review')");
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
    await session.waitFor("!!document.querySelector('.panel .recover .partial-review')");
    await session.click('.partial-review summary');
    assert.equal(
      await session.eval(
        "document.querySelector('.partial-review').textContent.includes('untracked')",
      ),
      true,
    );
    // D45: it says what happened -- the user stopped it -- not "interrupted".
    assert.match(
      String(await session.eval("document.querySelector('.recover-headline').textContent")),
      /You stopped this run\./,
    );
    await session.eval(
      "Array.from(document.querySelectorAll('.recover button')).find(b => b.textContent.trim() === 'Leave uncommitted').click()",
    );
    await session.waitFor(
      "document.querySelector('.recover')?.textContent.includes('Work from the run you stopped is still uncommitted.')",
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
      "!!document.querySelector('.run-foot') && !!document.querySelector('.md-table')",
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
    // A live stream says nothing -- the standing health indicator is gone, and
    // only a gap in it speaks -- so "live" is the absence of the notice.
    await session.waitFor(
      "!Array.from(document.querySelectorAll('.transport-notice')).some(n => n.textContent.includes('Reconnecting')) && !!document.querySelector('.md-table')",
    );
    await session.eval(
      "document.querySelector('.panel-body').scrollTop = 240; document.querySelector('.panel-body').dispatchEvent(new Event('scroll')); window.__dropEvents = true; window.__sources.at(-1).dispatchEvent(new Event('error'));",
    );
    await session.waitFor(
      "Array.from(document.querySelectorAll('.transport-notice')).some(n => n.textContent.includes('Reconnecting'))",
    );
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
      "document.querySelector('.thread')?.textContent.includes('Message written during transport gap')",
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
      await session.waitFor(
        "Array.from(document.querySelectorAll('.transport-notice')).some(n => n.textContent.includes('Reconnecting'))",
      );
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
      "!Array.from(document.querySelectorAll('.transport-notice')).some(n => n.textContent.includes('Reconnecting')) && document.querySelectorAll('.turn').length === 3",
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
    // A queued experiment is stopped from its own ⋯ menu: the card carries no
    // standing Stop, so that action lives where the card's other actions do.
    // Opening the menu selects that card, so the panel comes back to master
    // afterwards -- and the reason typed into the question survives the trip.
    await session.click(`[data-id="${queued.node.id}"] .card-more`);
    assert.equal(
      await session.eval(`!!document.querySelector('[data-id="${queued.node.id}"] .stop-run')`),
      true,
    );
    await session.click(`[data-id="${queued.node.id}"] .stop-run`);
    await session.waitFor(
      `(async () => (await (await fetch('/api/nodes/${queued.node.id}')).json()).node.status !== 'running')()`,
      { label: 'the queued run to stop' },
    );
    await session.click(`[data-id="${created.masterNodeId}"] .card`);
    await session.waitFor("!!document.querySelector('.ask input')");
    await session.type('.ask input', 'This reason belongs only to the first question');
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
  /**
   * D42: the agent asks a question, and the run waits for the user.
   *
   * The reported bug, end to end, in the mode it was reported in. Under
   * `acceptEdits` the agent's question used to return at once with no answer:
   * nothing was shown, and the agent wrote "I'll wait" into a run that ended.
   */
  test('a question from the agent waits for an answer, or for the agent to decide', async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'questions',
          description: '',
          location: dataDir,
          permissionMode: 'acceptEdits',
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const status = async (): Promise<string> =>
      ((await (await fetch(nodeUrl)).json()) as { node: { status: string } }).node.status;
    const conversation = "(document.querySelector('.conversation-content')?.textContent ?? '')";

    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'choose: how should this be built?' }),
    });
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.ask-choice')", {
      label: 'the question box',
    });

    // It waits: the card says so, the composer gives way, and nothing is sent
    // until the question has an answer.
    assert.equal(await status(), 'needs_you');
    assert.match(
      String(
        await session.eval(
          `document.querySelector('[data-id="${created.masterNodeId}"] .chip')?.textContent`,
        ),
      ),
      /Needs you/,
    );
    assert.equal(await session.eval("!!document.querySelector('.composer-row')"), false);
    assert.equal(
      await session.eval(
        "Array.from(document.querySelectorAll('.ask-choice button')).find(b => b.textContent === 'Send answer').disabled",
      ),
      true,
    );
    assert.match(
      String(await session.eval("document.querySelector('.choice-text').textContent")),
      /Which approach should I take\?/,
    );
    // "Other" is always offered, because the tool promises the agent it is.
    assert.equal(await session.eval("!!document.querySelector('.choice-other-text')"), true);

    // And it is still waiting after a reload: the question is server state.
    await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.ask-choice')");

    // Choosing an option shows its preview.
    await session.eval(
      "Array.from(document.querySelectorAll('.choice-option')).find(l => l.textContent.includes('Make it configurable')).querySelector('input').click()",
    );
    await session.waitFor(
      "document.querySelector('.choice-preview')?.textContent.includes('retries = 3')",
    );
    // Typing an answer of your own replaces it.
    await session.type('.choice-other-text', 'Use the existing pipeline');
    assert.equal(
      await session.eval(
        "Array.from(document.querySelectorAll('.choice-option')).find(l => l.textContent.includes('Make it configurable')).querySelector('input').checked",
      ),
      false,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-agent-question.png'));
    await session.eval(
      "Array.from(document.querySelectorAll('.ask-choice button')).find(b => b.textContent === 'Send answer').click()",
    );

    // The answer reached the agent, which carried on and finished.
    await session.waitFor(
      `!document.querySelector('.ask-choice') && ${conversation}.includes('You chose: Use the existing pipeline.')`,
      { timeoutMs: 20000 },
    );
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.status === 'ready')()`,
    );
    // What was asked, and what was answered, are in the conversation.
    const text = String(await session.eval(conversation));
    assert.match(text, /The agent asked: Which approach should I take\?/);
    assert.match(text, /Which approach should I take\? → Use the existing pipeline/);

    // Leaving it to the agent: it decides, says what it decided, and finishes.
    await fetch(`${nodeUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'choose: and this one?' }),
    });
    await session.waitFor("!!document.querySelector('.ask-choice')");
    await session.eval(
      "Array.from(document.querySelectorAll('.ask-choice button')).find(b => b.textContent === 'Let the agent decide').click()",
    );
    await session.waitFor(
      `!document.querySelector('.ask-choice') && ${conversation}.includes('Nobody chose, so I decided') && ${conversation}.includes('Left the decision to the agent.')`,
      { timeoutMs: 20000 },
    );
    await session.waitFor("!!document.querySelector('.composer-row')");
  });

  /** A project whose master has a stand-in run in flight, and helpers to watch it. */
  async function projectWithRun(
    name: string,
    prompt: string,
  ): Promise<{
    projectId: string;
    masterNodeId: string;
    nodeUrl: string;
    runId: string;
    detail: () => Promise<{
      node: { status: string };
      runs: Array<{
        id: string;
        status: string;
        endReason: string | null;
        stoppedBackground: number;
        commitSha: string | null;
      }>;
    }>;
  }> {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description: '',
          location: dataDir,
          permissionMode: 'acceptEdits',
        }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = `${BASE}/api/nodes/${created.masterNodeId}`;
    const { runId } = (await (
      await fetch(`${nodeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
    ).json()) as { runId: string };
    return {
      ...created,
      nodeUrl,
      runId,
      detail: async () => (await (await fetch(nodeUrl)).json()) as never,
    };
  }

  test('a run waiting for background work says so, and Finish now saves its results', async () => {
    const run = await projectWithRun('waiting', 'background: train the model');
    await session.goto(`${BASE}/?project=${run.projectId}&node=${run.masterNodeId}`);
    await session.waitFor(
      "document.querySelector('.activity-waiting')?.textContent.includes('Waiting for 1 background job')",
      { label: 'the waiting strip', timeoutMs: 15000 },
    );

    // Still running, and said as waiting on the card and in the header alike.
    assert.equal((await run.detail()).node.status, 'running');
    assert.match(
      String(await session.eval("document.querySelector('.activity-jobs').textContent")),
      /Stand-in background job/,
    );
    await session.waitFor(
      `document.querySelector('[data-id="${run.masterNodeId}"] .chip')?.textContent.includes('Waiting')`,
      { label: 'the card to say Waiting' },
    );
    assert.equal(
      await session.eval(
        `document.querySelector('[data-id="${run.masterNodeId}"] .chip').textContent`,
      ),
      'Waiting',
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-7-waiting.png'));

    await session.eval(
      "Array.from(document.querySelectorAll('.activity-waiting button')).find(b => b.textContent === 'Finish now').click()",
    );
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(run.nodeUrl)})).json()).node.status === 'ready')()`,
      { label: 'the run to finish', timeoutMs: 15000 },
    );
    const last = (await run.detail()).runs.at(-1)!;
    assert.equal(last.endReason, 'finished', 'finished, not stopped: its results were kept');
    assert.notEqual(last.commitSha, null);
    assert.equal(last.stoppedBackground, 1);
    await session.waitFor(
      "!document.querySelector('.activity-waiting') && document.querySelector('.conversation-content').textContent.includes('you chose Finish now')",
    );
  });

  test('switching experiments or projects, or leaving the page, never stops a run', async () => {
    const run = await projectWithRun('keeps-running', 'background: a long job');
    const other = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'elsewhere', description: '', location: dataDir }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const sibling = (
      (await (
        await fetch(`${BASE}/api/projects/${run.projectId}/nodes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parentId: run.masterNodeId,
            displayName: 'sibling',
            description: '',
          }),
        })
      ).json()) as { node: { id: string } }
    ).node;
    const stillRunning = async (): Promise<void> => {
      const detail = await run.detail();
      assert.equal(detail.node.status, 'running');
      assert.equal(detail.runs.find((r) => r.id === run.runId)?.status, 'running');
    };

    await session.goto(`${BASE}/?project=${run.projectId}&node=${run.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.activity-waiting')", { timeoutMs: 15000 });

    await session.click(`[data-id="${sibling.id}"]`);
    await session.waitFor("document.querySelector('.panel h2')?.textContent === 'sibling'");
    await stillRunning();

    await session.goto(`${BASE}/?project=${other.projectId}&node=${other.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.panel h2')");
    await stillRunning();

    await session.goto('about:blank');
    await new Promise((r) => setTimeout(r, 1000));
    await stillRunning();

    // And coming back, the page learns what it is doing from the tree alone.
    await session.goto(`${BASE}/?project=${run.projectId}&node=${run.masterNodeId}`);
    await session.waitFor("!!document.querySelector('.activity-waiting')", { timeoutMs: 15000 });
    await stillRunning();

    await fetch(`${run.nodeUrl}/finish`, { method: 'POST' });
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(run.nodeUrl)})).json()).node.status === 'ready')()`,
      { timeoutMs: 15000 },
    );
    assert.equal((await run.detail()).runs.filter((r) => r.status === 'cancelled').length, 0);
  });

  test('a detached process is waited for, and Stop ends it and says so', async () => {
    const run = await projectWithRun('detached', 'detach: start the server');
    await session.goto(`${BASE}/?project=${run.projectId}&node=${run.masterNodeId}`);
    await session.waitFor(
      "document.querySelector('.activity-jobs')?.textContent.includes('detached')",
      { label: 'the detached process to be found', timeoutMs: 15000 },
    );
    assert.equal((await findLeftovers(run.runId)).length > 0, true);

    await session.click('.panel .stop');
    await session.waitFor(
      "document.querySelector('.recover-headline')?.textContent.includes('You stopped this run.')",
      {
        label: 'the recovery notice',
        timeoutMs: 15000,
      },
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-7-stopped.png'));
    // Nothing the run started outlives it.
    assert.deepEqual(await findLeftovers(run.runId), []);
    const last = (await run.detail()).runs.at(-1)!;
    assert.equal(last.endReason, 'stopped');
    assert.equal(
      await session.eval(
        `document.querySelector('[data-id="${run.masterNodeId}"] .chip').textContent`,
      ),
      'Stopped',
    );
  });

  test('a new run clears an earlier Stop even when the browser missed the idle state', async () => {
    const run = await projectWithRun('rapid-restart', 'detach: first run');
    await session.goto(`${BASE}/?project=${run.projectId}&node=${run.masterNodeId}`);
    await session.waitFor(
      "document.querySelector('.activity-jobs')?.textContent.includes('detached')",
    );
    // Model an intermediary returning stale tree state during the short idle gap.
    // Node detail stays real, and the next running tree carries a different run ID.
    await session.eval(`window.__originalFetch = window.fetch;
      window.fetch = async (url, init) => {
        const response = await window.__originalFetch(url, init);
        if (!String(url).endsWith('/tree')) return response;
        const data = await response.clone().json();
        for (const node of data.nodes ?? []) {
          if (node.id === ${JSON.stringify(run.masterNodeId)} && !['running', 'needs_you'].includes(node.status)) {
            node.status = 'running'; node.activeRunId = ${JSON.stringify(run.runId)};
          }
        }
        return new Response(JSON.stringify(data), {status: response.status, headers: response.headers});
      };`);
    try {
      await session.click('.panel .stop');
      await session.waitFor(
        `(async () => (await (await fetch(${JSON.stringify(run.nodeUrl)})).json()).runs.at(-1)?.status === 'cancelled')()`,
      );
      assert.equal(await session.eval("document.querySelector('.panel .stop')?.disabled"), true);
      const response = await fetch(`${run.nodeUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'detach: second run' }),
      });
      assert.equal(response.status, 202);
      await session.waitFor(
        "document.querySelector('.activity-jobs')?.textContent.includes('detached') && document.querySelector('.panel .stop')?.disabled === false",
      );
      await session.click('.panel .stop');
      await session.waitFor(
        `(async () => { const d = await (await fetch(${JSON.stringify(run.nodeUrl)})).json(); return d.runs.length === 2 && d.runs.at(-1).status === 'cancelled'; })()`,
      );
    } finally {
      await session.eval('window.fetch = window.__originalFetch');
    }
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
      // A narrow canvas still keeps the bar's three parts on the bar.
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 1100,
        height: 780,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await session.eval(
          "(() => { const bar = document.querySelector('.menubar').getBoundingClientRect(); return ['.brand', '.project-picker', '.settings-button'].every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.width > 0 && r.left >= bar.left && r.right <= bar.right; }); })()",
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
    // Spend belongs to the project it was spent on, so Usage is in the
    // project's own menu rather than holding a permanent seat on the bar.
    const openUsage = async (): Promise<void> => {
      await session.click('.project-picker');
      await session.eval(
        "Array.from(document.querySelectorAll('.menu-panel [role=menuitem]')).find(b => b.textContent.includes('Usage')).click()",
      );
    };
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
    await openUsage();
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
        await session.eval("document.querySelector('.composer-row button.primary').disabled"),
        true,
      );
      await openUsage();
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
        await session.eval("document.querySelector('.composer-row button.primary').disabled"),
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
  test('the folder picker offers every existing project before another project in the same repository', async () => {
    const folder = join(dataDir, 'shared-reopening');
    await mkdir(folder);
    await git(['init', '--initial-branch=main'], folder);
    await writeFile(join(folder, 'README.md'), 'original');
    await git(['add', '-A'], folder);
    await git(['commit', '-m', 'base'], folder);
    const projects: Array<{ projectId: string; masterNodeId: string }> = [];
    for (const name of ['Shared one', 'Shared two']) {
      const response = await fetch(`${BASE}/api/projects/adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: folder, name }),
      });
      assert.equal(response.status, 201);
      projects.push((await response.json()) as { projectId: string; masterNodeId: string });
    }
    await session.goto(`${BASE}/?project=${projects[0]!.projectId}`);
    await session.waitFor("!!document.querySelector('[aria-label=Project]')");
    await session.click('[aria-label=Project]');
    await session.eval(
      "Array.from(document.querySelectorAll('.project-menu button')).find(b=>b.textContent==='Use an existing folder…').click()",
    );
    await session.waitFor("!!document.querySelector('.picker input')");
    await session.type('[aria-label="folder path"]', folder);
    await session.eval(
      "Array.from(document.querySelectorAll('.picker button')).find(b=>b.textContent==='Go').click()",
    );
    await session.waitFor("!document.querySelector('.picker > button').disabled");
    await session.click('.picker > button');
    await session.waitFor("document.querySelectorAll('.existing-project-row').length === 2");
    assert.equal(
      await session.eval("!!document.querySelector('.new-project .row .primary')"),
      false,
    );
    await session.screenshot(join(repoRoot, 'test-results', 'phase-2-reopening.png'));
    await session.eval(
      "Array.from(document.querySelectorAll('.matching-projects button')).find(b=>b.textContent.trim()==='Create another project here').click()",
    );
    await session.waitFor("!document.querySelector('.new-project .row button').disabled");
    await session.eval(
      "Array.from(document.querySelectorAll('.matching-projects button')).find(b=>b.getAttribute('aria-label')==='Open project Shared one').click()",
    );
    await session.waitFor(
      "!document.querySelector('.new-project') && document.querySelector('.project-picker-name')?.textContent==='Shared one'",
    );
  });

  test("create-only copies the parent's conversation once, or starts fresh when asked", async () => {
    const created = (await (
      await fetch(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'phase-three', description: '' }),
      })
    ).json()) as { projectId: string; masterNodeId: string };
    const nodeUrl = (id: string) => `${BASE}/api/nodes/${id}`;
    interface Detail {
      node: { writable: boolean };
      runs: unknown[];
      baseIsPinnedBehindLiveWalk: boolean;
      lineage: { conversationFrom: { id: string } | null; codeFrom: { id: string } | null };
    }
    const detail = async (id: string): Promise<Detail> =>
      (await (await fetch(nodeUrl(id))).json()) as Detail;
    const run = async (id: string, prompt: string): Promise<void> => {
      const response = await fetch(`${nodeUrl(id)}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      assert.equal(response.status, 202);
      await session.waitFor(
        `(async()=> (await (await fetch(${JSON.stringify(nodeUrl(id))})).json()).node.status === 'ready')()`,
      );
    };
    const saveChildForLater = async (name: string, fresh: boolean): Promise<string> => {
      await session.goto(`${BASE}/?project=${created.projectId}&node=${created.masterNodeId}`);
      await session.waitFor("!!document.querySelector('.add-child-handle')");
      await session.click('.add-child-handle');
      await session.type('[aria-label="experiment name"]', name);
      await session.waitFor(
        "Array.from(document.querySelectorAll('dialog button')).some(b=>b.textContent.trim()==='Save for later' && !b.disabled)",
      );
      // The parent has talked, so there is a conversation to leave behind.
      await session.waitFor("!!document.querySelector('dialog .start-fresh input')");
      if (fresh) await session.click('dialog .start-fresh input');
      await session.eval(
        "Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent.trim()==='Save for later').click()",
      );
      await session.waitFor(
        `!document.querySelector('dialog') && document.querySelector('.panel h2')?.textContent===${JSON.stringify(name)}`,
      );
      const tree = (await (
        await fetch(`${BASE}/api/projects/${created.projectId}/tree`)
      ).json()) as { nodes: Array<{ id: string; displayName: string }> };
      return tree.nodes.find((n) => n.displayName === name)!.id;
    };

    await run(created.masterNodeId, '? parent first context');
    const child = await saveChildForLater('Later experiment', false);
    const before = await detail(child);
    assert.equal(before.runs.length, 0);
    assert.equal(before.lineage.conversationFrom?.id, created.masterNodeId);
    assert.equal((await fetch(`${nodeUrl(child)}/reveal`, { method: 'POST' })).status, 409);

    await run(child, 'child commits a result');
    await run(created.masterNodeId, 'parent keeps working');
    assert.equal((await detail(created.masterNodeId)).node.writable, true);
    await run(child, '? child follows up');
    const latest = await detail(child);
    // Code stays pinned; the conversation stays the copy it was given.
    assert.equal(latest.baseIsPinnedBehindLiveWalk, true);
    assert.equal(latest.lineage.conversationFrom?.id, created.masterNodeId);
    await session.waitFor("document.querySelector('.panel')?.textContent.includes('Run context')");
    await session.screenshot(join(repoRoot, 'test-results', 'phase-3-context.png'));

    const fresh = await saveChildForLater('Fresh experiment', true);
    const freshDetail = await detail(fresh);
    assert.equal(freshDetail.lineage.conversationFrom, null);
    assert.equal(freshDetail.lineage.codeFrom?.id, created.masterNodeId);
    await session.waitFor(
      "document.querySelector('.panel-meta')?.textContent.includes('fresh conversation')",
    );
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
      "!!document.querySelector('.add-child-handle') && !!document.querySelector('.card')",
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
    /**
     * Selecting an experiment must not pin it.
     *
     * React Flow's drag threshold defaults to zero, so a click used to start
     * and end a drag and write a position -- pinning every card you looked at,
     * and offering "Automatic position" for a node nobody had dragged.
     */
    await session.click('.react-flow__node');
    await session.waitFor(
      `(async () => (await (await fetch(${JSON.stringify(nodeUrl)})).json()).node.positionX === null)()`,
    );
    assert.equal(
      await session.eval(
        "Array.from(document.querySelectorAll('.canvas-tools button')).some(b => b.textContent === 'Automatic position')",
      ),
      false,
      'a click does not pin',
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
    // The map's + is a button: a click opens the branch dialog without a drag.
    await session.click('.add-child-handle');
    await session.waitFor('!!document.querySelector(\'dialog[aria-label="Branch experiment"]\')');
    await session.eval(
      "Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click()",
    );
    await session.waitFor('!document.querySelector(\'dialog[aria-label="Branch experiment"]\')');
    // And the keyboard: Enter on the focused + does the same.
    await session.eval("document.querySelector('.add-child-handle').focus()");
    for (const type of ['keyDown', 'keyUp'])
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
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
    // A backdrop click cannot discard this form. Through the harness's mouse
    // helper: a dispatched press without `buttons` set is not delivered as a
    // real press, so this used to pass whatever the dialog did.
    await session.mouse('mousePressed', 2, 2);
    await session.mouse('mouseReleased', 2, 2);
    assert.equal(
      await session.eval('document.querySelector(\'[aria-label="experiment name"]\').value'),
      'Keyboard experiment',
    );
    await session.screenshot(join(repoRoot, 'test-results', 'milestone-6-branch-1280.png'));
    await session.eval(
      "Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Cancel').click()",
    );
    await session.waitFor("document.activeElement?.classList.contains('add-child-handle')");
    /**
     * Canvas hints: one trigger, three ways out, and nothing inside that
     * repeats the trigger's job. The old "Map key" panel carried its own
     * "Close map key" button where the content should have been.
     */
    await session.click('.canvas-hints-trigger');
    await session.waitFor("!!document.querySelector('.canvas-hints-panel')");
    assert.equal(
      await session.eval("document.querySelectorAll('.canvas-hints-panel button').length"),
      0,
      'nothing inside repeats what the trigger already does',
    );
    await session.click('.canvas-hints-trigger');
    assert.equal(await session.eval("!!document.querySelector('.canvas-hints-panel')"), false);
    // Escape closes it and puts the keyboard back where it started.
    await session.click('.canvas-hints-trigger');
    await session.waitFor("!!document.querySelector('.canvas-hints-panel')");
    for (const type of ['keyDown', 'keyUp'])
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    await session.waitFor("!document.querySelector('.canvas-hints-panel')");
    assert.equal(
      await session.eval("document.activeElement?.classList.contains('canvas-hints-trigger')"),
      true,
    );
    // And a press outside closes it. Through the harness's mouse helper, which
    // sets `buttons` -- a dispatched press without it is not delivered as a
    // mousedown at all, so the check would pass without proving anything.
    await session.click('.canvas-hints-trigger');
    await session.waitFor("!!document.querySelector('.canvas-hints-panel')");
    await session.mouse('mousePressed', 900, 300);
    await session.mouse('mouseReleased', 900, 300);
    await session.waitFor("!document.querySelector('.canvas-hints-panel')");
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
    await session.click('.panel .collapse');
    await session.waitFor(
      "document.querySelector('.app').classList.contains('panel-hidden') && !!document.querySelector('.conversation-rail')",
    );
    assert.equal(
      await session.eval(
        "document.querySelector('.conversation-rail').getBoundingClientRect().width",
      ),
      46,
      'the conversation collapses to its rail rather than vanishing',
    );
    // A collapsed panel stays collapsed when another experiment is chosen: a
    // collapse that reopens on the next click is not a collapse.
    await session.click('.react-flow__node:last-child');
    assert.equal(
      await session.eval("document.querySelector('.app').classList.contains('panel-hidden')"),
      true,
    );
    // The rail itself is the way back.
    await session.click('.conversation-rail');
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
      for (const selector of ['.composer textarea', '.composer .hint', '.composer-row button.primary', '.panel-meta', '.card-name', '.chip']) {
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
      "document.querySelector('.composer-row button.primary').getBoundingClientRect().bottom <= 720",
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
    // Parked partway up, not at the bottom: following the newest output is a
    // different behaviour from restoring where someone was reading, and this is
    // the one that needs the position itself to survive.
    const scrolled = Number(
      await session.eval(
        "const b=document.querySelector('.panel-body:not([hidden])'); b.scrollTop = Math.floor((b.scrollHeight - b.clientHeight) / 2); b.dispatchEvent(new Event('scroll')); b.scrollTop",
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
            "document.querySelector('.composer-row button.primary').getBoundingClientRect().right",
          ),
        ) <= width,
      );
      await session.screenshot(join(repoRoot, 'test-results', `milestone-6-${width}-large.png`));
      // And the map at the same width: the canvas controls are one family and
      // have to stay inside the window, wrapping rather than overflowing it.
      await session.click('.view-switch button:first-child');
      await session.waitFor("!!document.querySelector('.canvas-tools')");
      assert.equal(
        await session.eval('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
      );
      assert.equal(
        await session.eval(
          `Array.from(document.querySelectorAll('.canvas-tools .canvas-tool')).every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= ${width} && r.bottom <= window.innerHeight; })`,
        ),
        true,
        'every canvas control stays on screen',
      );
      // One family means one height, whatever the label inside it.
      assert.equal(
        await session.eval(
          "new Set(Array.from(document.querySelectorAll('.canvas-tools .canvas-tool')).map(b => Math.round(b.getBoundingClientRect().height))).size",
        ),
        1,
      );
      await session.screenshot(join(repoRoot, 'test-results', `milestone-6-${width}-map.png`));
      await session.click('.view-switch button:last-child');
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
      "document.querySelector('.composer-row button.primary').scrollIntoView({block:'nearest'})",
    );
    assert.ok(
      Number(
        await session.eval(
          "document.querySelector('.composer-row button.primary').getBoundingClientRect().bottom",
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
  /** A press or release at a point, with `buttons` set so it is a real one. */
  mouse(type: 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: number, y: number): Promise<void>;
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
