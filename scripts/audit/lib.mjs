/**
 * Shared by the audit reproductions: a Bonsai server on a temporary data
 * folder with the stand-in agent, and a JSON client for it.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startBonsai(dataDir, env = {}) {
  const port = 9100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--no-warnings', join(repoRoot, 'packages/server/dist/index.js')],
    {
      env: {
        ...process.env,
        BONSAI_DATA_DIR: dataDir,
        BONSAI_PORT: String(port),
        BONSAI_FAKE_AGENT: '1',
        BONSAI_FAKE_DELAY_MS: '50',
        ...env,
      },
      stdio: 'ignore',
    },
  );
  for (;;) {
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
    for (;;) {
      const res = await api('GET', `/api/nodes/${nodeId}`);
      if (res.status !== 200) return res;
      if (!['running', 'needs_you'].includes(res.body.node.status)) return res;
      await delay(100);
    }
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
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
