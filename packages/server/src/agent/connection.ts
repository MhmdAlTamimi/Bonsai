import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ConnectionState, ConnectionStatus } from '@bonsai/shared';

/**
 * Whether Bonsai can actually reach Claude, established by asking it.
 *
 * The previous check looked for credential files on disk and was wrong in the
 * way that matters most: on macOS a subscription login lives in the Keychain,
 * where nothing on disk reveals it. A new user on a Mac would be told there
 * were no credentials, silently fall back to the stand-in, and conclude that
 * placeholder files were what Bonsai does. A heuristic that is confidently
 * wrong is worse than no check.
 *
 * So this runs a real query and classifies what comes back. It is deliberately
 * the smallest possible one -- a custom one-line system prompt instead of the
 * Claude Code preset, no tools, one turn, a two-word answer -- because it runs
 * at startup and whenever the user asks, and it must not cost anything anyone
 * would notice.
 */
export async function probeConnection(options: {
  model: string | null;
  apiKey: string | null;
  timeoutMs?: number;
}): Promise<ConnectionStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);

  let apiKeySource: string | null = null;
  let model: string | null = null;

  try {
    for await (const message of query({
      prompt: 'Reply with the single word: ok',
      options: {
        abortController: controller,
        maxTurns: 1,
        allowedTools: [],
        // Not the claude_code preset: this is a liveness check, not a coding
        // session, and the preset is thousands of tokens of instructions and
        // tool definitions that would be paid for on every check.
        systemPrompt: 'You are a connection check. Reply with exactly: ok',
        settingSources: [],
        ...(options.model === null ? {} : { model: options.model }),
        ...(options.apiKey === null ? {} : { env: { ...process.env, ANTHROPIC_API_KEY: options.apiKey } }),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        apiKeySource = message.apiKeySource;
        model = message.model;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) {
          const detail =
            'errors' in message && Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join('; ')
              : 'result' in message && typeof message.result === 'string' && message.result !== ''
                ? message.result
                : `the run ended: ${message.subtype}`;
          return classify(detail);
        }
        // Reaching a successful result means a model call went through, which
        // is the only thing that actually proves the credential works.
        return {
          state: 'connected',
          apiKeySource: apiKeySource ?? 'unknown',
          model: model ?? options.model ?? 'unknown',
          message: null,
        };
      }
    }
    return classify('the agent exited without answering');
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        state: 'error',
        apiKeySource: null,
        model: null,
        message: 'The connection check timed out. Claude Code may be starting up, or offline.',
      };
    }
    return classify(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Turn whatever came back into something the user can act on.
 *
 * Matching on message text is imprecise by nature, so the fallback is an
 * honest "something else went wrong" carrying the original text, rather than a
 * confident guess. Being wrong about *why* is how the old check caused harm.
 */
function classify(raw: string): ConnectionStatus {
  const text = raw.toLowerCase();
  const base = { apiKeySource: null, model: null };

  const missingCredential =
    /\b(401|403)\b/.test(text) ||
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    text.includes('authenticate') ||
    text.includes('invalid api key') ||
    text.includes('api key') ||
    text.includes('not logged in') ||
    text.includes('please run') ||
    text.includes('/login') ||
    text.includes('credential');

  if (missingCredential) {
    return { ...base, state: 'no_credential', message: raw };
  }
  if (/\b429\b/.test(text) || text.includes('rate limit') || text.includes('overloaded') ||
      text.includes('usage limit') || text.includes('quota')) {
    return { ...base, state: 'rate_limited', message: raw };
  }
  if (text.includes('enoent') || text.includes('spawn')) {
    return {
      ...base,
      state: 'error',
      message:
        `Could not start Claude Code. The Agent SDK ships it as a subprocess, so this usually ` +
        `means the install is incomplete — try reinstalling dependencies. (${raw})`,
    };
  }
  return { ...base, state: 'error', message: raw };
}

export const DISCONNECTED_STATES: readonly ConnectionState[] = [
  'no_credential',
  'rate_limited',
  'error',
  'unknown',
];
