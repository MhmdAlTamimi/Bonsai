import type { ModelUsage, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { RunEvent } from './AgentRunner.js';

export type UsageEvent = Extract<RunEvent, { type: 'done' }>;
type Totals = Omit<UsageEvent, 'type' | 'model' | 'usageStatus'>;
type CostStore = SessionStore & { costState?(sessionId: string): SessionStoreEntry | null };
const zero = (): Totals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

function tokens(models: Record<string, ModelUsage>): Totals {
  const result = zero();
  for (const model of Object.values(models)) {
    result.inputTokens += model.inputTokens ?? 0;
    result.outputTokens += model.outputTokens ?? 0;
    result.cacheReadTokens! += model.cacheReadInputTokens ?? 0;
    result.cacheCreationTokens! += model.cacheCreationInputTokens ?? 0;
  }
  return result;
}

/** Freeze before query(): result totals include earlier resumed turns. */
export async function sessionUsage(
  store: CostStore | undefined,
  sessionId: string | null,
  cwd: string,
): Promise<SessionUsage> {
  if (store === undefined || sessionId === null) return new SessionUsage(zero(), {});
  const state = store.costState
    ? store.costState(sessionId)
    : (await store.load({ sessionId, projectKey: cwd }))
        ?.slice()
        .reverse()
        .find((entry) => entry.type === 'cost-state');
  // The official SDK fork omits cost-state, and resumes such a copy with zero spend.
  if (state == null) return new SessionUsage(zero(), {});
  if (
    typeof state.totalCostUSD !== 'number' ||
    state.modelUsage === null ||
    typeof state.modelUsage !== 'object'
  )
    return new SessionUsage(null, {});
  const models = state.modelUsage as Record<string, ModelUsage>;
  return new SessionUsage({ ...tokens(models), costUsd: state.totalCostUSD }, models);
}

export class SessionUsage {
  constructor(
    private readonly before: Totals | null,
    private readonly models: Record<string, ModelUsage>,
  ) {}

  result(message: {
    total_cost_usd: number;
    usage: { input_tokens?: number; output_tokens?: number };
    modelUsage?: Record<string, ModelUsage>;
  }): UsageEvent {
    const models = message.modelUsage ?? {};
    const total =
      Object.keys(models).length > 0
        ? tokens(models)
        : {
            ...zero(),
            inputTokens: message.usage?.input_tokens ?? 0,
            outputTokens: message.usage?.output_tokens ?? 0,
          };
    total.costUsd = message.total_cost_usd;
    const delta = zero();
    let known = this.before !== null && Number.isFinite(message.total_cost_usd);
    for (const key of Object.keys(delta) as Array<keyof Totals>) {
      const value = total[key] ?? 0;
      const difference = value - (this.before?.[key] ?? 0);
      if (!Number.isFinite(value) || !Number.isFinite(difference) || difference < -1e-9)
        known = false;
      delta[key] = Math.max(0, difference);
    }
    const primary = Object.entries(models).sort(
      (a, b) =>
        (b[1].outputTokens ?? 0) -
        (this.models[b[0]]?.outputTokens ?? 0) -
        ((a[1].outputTokens ?? 0) - (this.models[a[0]]?.outputTokens ?? 0)),
    )[0];
    return {
      type: 'done',
      ...(known ? delta : zero()),
      model: primary ? (primary[1].canonicalModel ?? primary[0]) : null,
      usageStatus: known ? 'recorded' : 'unknown',
    };
  }
}
