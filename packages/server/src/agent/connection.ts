import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AgentModel, ConnectionState, ConnectionStatus } from '@bonsai/shared';

import { Inbox } from './session.js';

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
 *
 * While it is connected it also asks which models this credential can use, so
 * the model picker follows new releases without a new Bonsai. That is a control
 * request, which the SDK only answers when the prompt is streamed in -- hence
 * the Inbox rather than a plain string.
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
  let models: Promise<AgentModel[] | null> = Promise.resolve(null);
  const inbox = new Inbox();
  inbox.send('Reply with the single word: ok');

  try {
    const session = query({
      prompt: inbox,
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
        ...(options.apiKey === null
          ? {}
          : { env: { ...process.env, ANTHROPIC_API_KEY: options.apiKey } }),
      },
    });
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init') {
        apiKeySource = message.apiKeySource;
        model = message.model;
        // Asked now, answered while the check runs. A Claude Code that cannot
        // say leaves the picker on its built-in list; it never fails the check.
        models = session.supportedModels().then(agentModels, () => null);
      }
      if (message.type === 'result') {
        inbox.close();
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
        const offered = await Promise.race([models, delay(MODELS_WAIT_MS, null)]);
        return {
          state: 'connected',
          apiKeySource: apiKeySource ?? 'unknown',
          model: model ?? options.model ?? 'unknown',
          message: null,
          ...(offered === null || offered.length === 0 ? {} : { models: offered }),
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
    inbox.close();
    clearTimeout(timeout);
  }
}

/** How long a finished check waits for the model list before answering without it. */
const MODELS_WAIT_MS = 5_000;

const delay = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());

/**
 * Claude Code's model rows, as the picker offers them.
 *
 * Each row is stored by the model id it resolves to (`claude-opus-5-5`), not an
 * alias like `opus`: a saved choice should keep meaning the model that was
 * picked, and it matches the ids already in people's settings. A date on the
 * end (`claude-haiku-4-5-20251001`) is dropped for the same reason -- the id
 * without it names the same model. The "default" row is left out -- the picker
 * has its own "Claude Code default" -- and a model under two rows is offered
 * once. Claude Code names its rows by family only ("Opus"), so the label comes
 * from the id when the name has no version in it.
 */
export function agentModels(rows: readonly ModelInfo[]): AgentModel[] {
  // When any row says what effort it takes, a row that lists none takes none
  // (Haiku); when none do, it is simply not known, and the picker offers all.
  const effortKnown = rows.some(
    (row) => row.supportedEffortLevels !== undefined || row.supportsEffort !== undefined,
  );
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const row of rows) {
    const id = (row.resolvedModel ?? row.value).replace(/-\d{8}$/, '');
    if (row.value === 'default' || id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: /\d/.test(row.displayName) ? row.displayName : modelLabel(id, row.displayName),
      description: row.description || null,
      efforts:
        row.supportsEffort === false
          ? []
          : (row.supportedEffortLevels ?? (effortKnown ? [] : null)),
    });
  }
  return models;
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
  if (
    /\b429\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('overloaded') ||
    text.includes('usage limit') ||
    text.includes('quota')
  ) {
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

/** `claude-opus-5-5` → "Opus 5.5", `claude-haiku-4-5` → "Haiku 4.5"; anything else as given. */
function modelLabel(id: string, fallback: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (match === null) return fallback || id;
  const [, family, major, minor] = match;
  return `${family!.charAt(0).toUpperCase()}${family!.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`;
}

export const DISCONNECTED_STATES: readonly ConnectionState[] = [
  'no_credential',
  'rate_limited',
  'error',
  'unknown',
];
