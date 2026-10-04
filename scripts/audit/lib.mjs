/**
 * Shared by the audit reproductions: a Bonsai server on a temporary data
 * folder with the stand-in agent, and a JSON client for it.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `realAgent` runs the real Claude Code instead of the stand-in, with an
 * environment holding only PATH plus `env`: nothing of this shell's own
 * credentials or Claude Code settings reaches it (see fake-api.mjs).
 */
export async function startBonsai(dataDir, env = {}, { realAgent = false } = {}) {
  if (realAgent) {
    const target = new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
      throw new Error(
        'Audit SDK runs require ANTHROPIC_BASE_URL pointing at scripts/audit/fake-api.mjs.',
      );
    const identity = await fetch(new URL('/__bonsai_audit__', target), {
      signal: globalThis.AbortSignal.timeout(2000),
    }).then((r) => r.json());
    if (identity.server !== 'scripts/audit/fake-api.mjs')
      throw new Error('Refusing to run the real SDK against an unverified API server.');
  }
  const port = 9100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--no-warnings', join(repoRoot, 'packages/server/dist/index.js')],
    {
      env: {
        ...(realAgent
          ? { PATH: process.env.PATH }
          : { ...process.env, BONSAI_FAKE_AGENT: '1', BONSAI_FAKE_DELAY_MS: '50' }),
        BONSAI_DATA_DIR: dataDir,
        BONSAI_PORT: String(port),
        ...env,
      },
      stdio: 'ignore',
    },
  );
  const startupDeadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Audit server exited before readiness (${child.exitCode ?? child.signalCode}).`,
      );
    if (Date.now() > startupDeadline) {
      child.kill('SIGKILL');
      throw new Error('Audit server did not become ready within 15 seconds.');
    }
    try {
      if ((await fetch(`${base}/api/settings`)).ok) break;
    } catch {
      // Not up yet.
    }
    await delay(50);
  }
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text.
    }
    return { status: res.status, body: parsed };
  };
  /** Waits for a node to stop running; returns its detail, or the failed response. */
  const settle = async (nodeId) => {
    const deadline = Date.now() + 240000;
    for (;;) {
      if (Date.now() > deadline)
        throw new Error(`Audit run ${nodeId} did not settle within 4 minutes.`);
      const res = await api('GET', `/api/nodes/${nodeId}`);
      if (res.status !== 200) return res;
      if (!['running', 'needs_you'].includes(res.body.node.status)) return res;
      await delay(100);
    }
  };
  /** SIGKILL by default: a crash. SIGTERM is the app being closed properly. */
  const stop = async (signal = 'SIGKILL') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    await exited;
  };
  return { base, api, settle, stop };
}

/** Git with a fixed identity, for building fixtures. */
export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'You',
  GIT_AUTHOR_EMAIL: 'you@example.com',
  GIT_COMMITTER_NAME: 'You',
  GIT_COMMITTER_EMAIL: 'you@example.com',
};
