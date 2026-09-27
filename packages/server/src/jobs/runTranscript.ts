import type { CompactionNote } from '@bonsai/shared';

import type { RunEvent } from '../agent/AgentRunner.js';
import type { EventBus } from '../api/events.js';
import type { RunTotals, Store } from '../db/store.js';

/**
 * What one run says and spends, as it happens.
 *
 * Every event the agent produces lands here: written to the conversation,
 * streamed to the panel, and counted. The totals it builds are the same for
 * every way a run can end -- finished, stopped, failed -- which used to be
 * three copies of the same eleven fields, each one a chance to forget one.
 */
export class RunTranscript {
  private seq = 0;
  cost = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheCreationTokens = 0;
  model: string | null = null;
  apiKeySource: string | null = null;
  /**
   * The tool names the agent was actually offered, and how many calls it
   * made. "Which tools did it have" is the exact question behind "it said it
   * edited files but committed nothing", a bug this project has already hit.
   */
  toolsOffered: string[] | null = null;
  toolCalls = 0;
  /** The last message the agent wrote; kept only if the run finishes (see `session_position`). */
  position: string | null = null;
  /** Compaction replaced older turns, so an older cut point would copy them back. */
  compacted = false;
  readonly startedAt = Date.now();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly run: { runId: string; nodeId: string; projectId: string },
  ) {}

  /** Records one event. An `error` event throws, ending the run as failed. */
  record(event: RunEvent): void {
    const { runId, nodeId, projectId } = this.run;
    switch (event.type) {
      case 'session':
        this.store.setSessionId(nodeId, event.sessionId);
        break;
      case 'position':
        this.position = event.messageId;
        break;
      case 'compacted': {
        // Earlier messages are now behind a summary; the cut point starts again.
        this.position = null;
        this.compacted = true;
        const note: CompactionNote = {
          compaction: {
            trigger: event.trigger,
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
          },
        };
        this.store.appendMessage({ nodeId, runId, role: 'system', kind: 'text', content: note });
        this.bus.publish(projectId, { type: 'tree.updated', projectId });
        break;
      }
      case 'notice':
        this.store.appendMessage({
          nodeId,
          runId,
          role: 'system',
          kind: 'text',
          content: event.text,
        });
        this.bus.publish(projectId, { type: 'tree.updated', projectId });
        break;
      case 'text':
        this.seq += 1;
        this.store.appendMessage({
          nodeId,
          runId,
          role: 'assistant',
          kind: 'text',
          content: event.text,
        });
        this.bus.publish(projectId, {
          type: 'run.delta',
          nodeId,
          runId,
          seq: this.seq,
          text: event.text,
        });
        break;
      case 'tool': {
        this.toolCalls += 1;
        this.seq += 1;
        const tool = {
          name: event.name,
          ...(event.parentToolUseId === undefined
            ? {}
            : { parentToolUseId: event.parentToolUseId }),
          detail: event.detail,
          ...(event.id === undefined ? {} : { id: event.id }),
          ...(event.description === undefined ? {} : { description: event.description }),
        };
        this.store.appendMessage({
          nodeId,
          runId,
          role: 'assistant',
          kind: 'tool_use',
          content: tool,
        });
        this.bus.publish(projectId, {
          type: 'run.delta',
          nodeId,
          runId,
          seq: this.seq,
          text: `${event.name}: ${event.detail}`,
          tool,
        });
        break;
      }
      /**
       * What the call produced, as its own message rather than an edit of the
       * call's row: messages are append-only, and the conversation pairs the
       * two by the tool's id when it draws the block.
       */
      case 'tool_result':
        this.seq += 1;
        this.store.appendMessage({
          nodeId,
          runId,
          role: 'assistant',
          kind: 'tool_result',
          content: event.result,
        });
        this.bus.publish(projectId, {
          type: 'run.delta',
          nodeId,
          runId,
          seq: this.seq,
          text: '',
          toolResult: event.result,
        });
        break;
      case 'model':
        this.model = event.model;
        this.apiKeySource = event.apiKeySource ?? null;
        this.toolsOffered = event.tools ?? this.toolsOffered;
        break;
      case 'done':
        // Assigned, never accumulated: total_cost_usd is documented as the
        // running total for the whole query() call, so summing results
        // across turns would count the same tokens repeatedly.
        this.cost = event.costUsd;
        this.inputTokens = event.inputTokens;
        this.outputTokens = event.outputTokens;
        this.cacheReadTokens = event.cacheReadTokens ?? 0;
        this.cacheCreationTokens = event.cacheCreationTokens ?? 0;
        this.model = event.model ?? this.model;
        break;
      case 'error':
        throw new Error(event.error);
    }
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  /** What the run spent and did, for its row -- plus whatever this ending adds. */
  totals(extra: Partial<RunTotals> = {}): RunTotals {
    return {
      cost: this.cost,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      model: this.model,
      apiKeySource: this.apiKeySource,
      // Especially on a failure: "which tools did it have" is most of the
      // answer to "why did it do that".
      toolsOffered: this.toolsOffered,
      toolCalls: this.toolCalls,
      durationMs: this.durationMs,
      ...extra,
    };
  }
}
