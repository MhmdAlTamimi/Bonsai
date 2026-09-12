import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionStatus } from '@bonsai/shared';

import { probeConnection } from '../agent/connection.js';
import type { Settings } from '../settings.js';

const run = promisify(execFile);

/**
 * Holds the last known connection result, so the gate can answer instantly and
 * the probe only runs when it is actually worth running.
 *
 * The gate BLOCKS: with no working credential there is no project creation, no
 * runs and no chat. Falling back to a stand-in was right while this was
 * something to review and wrong the moment it was something to use — a new
 * user would get placeholder files and reasonably conclude that is what Bonsai
 * does. Better to stop and say what is wrong.
 */
export class Connection {
  private status: ConnectionStatus = {
    state: 'unknown',
    apiKeySource: null,
    model: null,
    message: null,
  };
  private inFlight: Promise<ConnectionStatus> | null = null;

  constructor(
    private readonly settings: Settings,
    /** True when the runner is the stand-in, which has nothing to authenticate. */
    private readonly standIn = false,
  ) {}

  current(): ConnectionStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status.state === 'connected';
  }

  /** Re-checks, collapsing concurrent callers onto one probe. */
  async check(): Promise<ConnectionStatus> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.resolve()
      .then((result) => {
        this.status = result;
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Free check first, paid check second.
   *
   * `claude auth status` costs nothing and settles the common case — nobody has
   * signed in and no key is stored — without spending a single token. Only when
   * a credential appears to exist is the real query worth running, and it has
   * to run, because "logged in" is not the same as "still works": an expired
   * token reports logged in right up until it fails.
   */
  private async resolve(): Promise<ConnectionStatus> {
    /**
     * The stand-in agent has no credential, because it talks to nothing.
     *
     * Without this the gate blocks the whole app on a machine with no Claude
     * CLI -- which is every CI runner, and is exactly how the browser test
     * failed on its first run: the server came up, the page loaded, and the
     * connection screen sat there instead of the app.
     *
     * This is not a bypass. BONSAI_FAKE_AGENT is opt-in and prints a warning
     * at startup, so it cannot be reached by accident, and the reason the gate
     * exists -- stopping a real run from failing halfway with no credential --
     * does not apply when no real run can happen.
     */
    if (this.standIn) {
      return { state: 'connected', apiKeySource: 'stand-in', model: 'stand-in', message: null };
    }

    const key = this.settings.apiKey();
    if (key === null) {
      const cli = await this.cliAuthStatus();
      if (!cli.available) {
        return {
          state: 'no_credential',
          apiKeySource: null,
          model: null,
          message:
            'The Claude Code CLI is not installed, and no API key is stored. Install it and sign ' +
            'in, or add an API key.',
        };
      }
      if (!cli.loggedIn) {
        return {
          state: 'no_credential',
          apiKeySource: null,
          model: null,
          message: 'Not signed in to Claude, and no API key is stored.',
        };
      }
    }

    return probeConnection({ model: this.settings.model(), apiKey: key });
  }

  /**
   * What the Claude CLI says about its own credential.
   *
   * `claude auth status` returns structured JSON and costs nothing, so it is
   * the fast path: it says whether a credential exists and which kind. It does
   * NOT say whether that credential still works — an expired token reports
   * logged in — which is why the paid probe still runs to confirm liveness.
   */
  async cliAuthStatus(): Promise<CliAuthStatus> {
    try {
      const { stdout } = await run('claude', ['auth', 'status'], {
        timeout: 20_000,
        env: { ...process.env },
      });
      const parsed = JSON.parse(stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
      };
      return {
        available: true,
        loggedIn: parsed.loggedIn === true,
        authMethod: parsed.authMethod ?? null,
      };
    } catch (err) {
      const e = err as { code?: string };
      return {
        available: e.code !== 'ENOENT',
        loggedIn: false,
        authMethod: null,
      };
    }
  }

  /**
   * Starts the Claude subscription sign-in.
   *
   * `claude auth login --claudeai` is the real command — an earlier version of
   * this called `claude login`, which is not a subcommand at all: the CLI would
   * have taken "login" as a PROMPT and asked the model about it.
   *
   * The flow is interactive and opens a browser, so this spawns it and captures
   * what it prints — usually a URL — rather than pretending to complete it. If
   * it needs a real terminal, the UI says to run it in one. Reporting a sign-in
   * that did not happen would repeat the mistake this whole change exists to
   * fix, so success is decided by re-probing afterwards, never by this call.
   */
  async login(): Promise<{ ok: boolean; output: string }> {
    const before = await this.cliAuthStatus();
    if (!before.available) {
      return {
        ok: false,
        output:
          'The `claude` command is not on PATH. Install the Claude Code CLI, or use an API key ' +
          'instead.',
      };
    }

    try {
      const { stdout, stderr } = await run('claude', ['auth', 'login', '--claudeai'], {
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      return {
        ok: false,
        output:
          output === ''
            ? `Sign-in could not be completed from inside Bonsai — it needs an interactive ` +
              `terminal. Run this, then press Recheck:\n\n    claude auth login --claudeai\n\n` +
              `(${e.message ?? 'no output'})`
            : output,
      };
    }
  }
}

export interface CliAuthStatus {
  /** Whether the `claude` CLI is installed at all. */
  available: boolean;
  loggedIn: boolean;
  authMethod: string | null;
}

/** Opens a folder in the platform's file manager. */
export async function revealInFileManager(path: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    await run(command, [path], { timeout: 10_000 });
  } catch {
    // `explorer` exits non-zero even on success, and a headless Linux box has
    // no file manager at all. Neither is worth failing the request over.
  }
}
