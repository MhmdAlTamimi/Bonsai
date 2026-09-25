import type { DraftBasis, MessageView, ToolResultContent } from '@bonsai/shared';

/**
 * An experiment's conversation as plain text, for drafting a reference from it.
 *
 * Everything goes in when it fits. When it does not, what is cut is what a
 * summary needs least, in this order:
 *
 *   1. tool output -- the bulk of a long run, and the least useful to a
 *      summary; which tool ran on what is kept, as a one-line marker;
 *   2. the middle of the conversation, keeping its most recent part whole.
 *
 * The first request and the experiment's notes (CONTEXT.md) are always kept:
 * the first says what the experiment was for, and the notes are the most
 * trustworthy thing it wrote. When messages are left out the text says so,
 * so a gap is not read as nothing having happened.
 */

/** About 60k tokens: generous for a summary, bounded for cost. */
export const DRAFT_BUDGET = 240_000;
const TOOL_OUTPUT_CAP = 2_000;
const NOTES_CAP = 40_000;

interface Entry {
  text: string;
  /** A tool's output, the first thing to go when trimming. */
  output: boolean;
}

export function conversationText(
  messages: readonly MessageView[],
  notes: string | null,
  budget = DRAFT_BUDGET,
): { text: string; basis: DraftBasis } {
  const notesPart =
    notes === null || notes.trim() === ''
      ? ''
      : `## Experiment notes (CONTEXT.md)\n\n${notes.slice(0, NOTES_CAP)}\n\n`;
  const entries = messages.flatMap(toEntries);
  const room = Math.max(0, budget - notesPart.length);
  const total = messages.length;

  let kept = entries;
  let toolOutputOmitted = false;
  let omitted = 0;
  if (size(kept) > room) {
    kept = kept.filter((entry) => !entry.output);
    toolOutputOmitted = kept.length !== entries.length;
  }
  if (size(kept) > room && kept.length > 1) {
    const [first, ...rest] = kept;
    const recent: Entry[] = [];
    let used = first!.text.length + 80;
    for (let i = rest.length - 1; i >= 0; i -= 1) {
      const length = rest[i]!.text.length + 1;
      if (used + length > room) break;
      used += length;
      recent.unshift(rest[i]!);
    }
    omitted = rest.length - recent.length;
    kept = [
      first!,
      {
        text: `[${omitted} earlier message${omitted === 1 ? '' : 's'} left out to fit]`,
        output: false,
      },
      ...recent,
    ];
  }

  return {
    text: `${notesPart}## Conversation\n\n${kept.map((entry) => entry.text).join('\n')}`,
    basis: {
      messages: total,
      included: total - omitted,
      toolOutputOmitted,
      notes: notesPart !== '',
    },
  };
}

function size(entries: readonly Entry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length + 1, 0);
}

function toEntries(message: MessageView): Entry[] {
  const content = message.content;
  if (message.kind === 'tool_use') {
    const call = content as { name?: string; detail?: string };
    const detail = (call.detail ?? '').trim();
    return [
      { text: `[${call.name ?? 'tool'}${detail === '' ? '' : `: ${detail}`}]`, output: false },
    ];
  }
  if (message.kind === 'tool_result') {
    const text = toolOutput(content as ToolResultContent);
    return text === '' ? [] : [{ text, output: true }];
  }
  if (message.role === 'system') {
    if (typeof content === 'object' && content !== null && 'compaction' in content) {
      return [{ text: 'Note: the conversation was compacted here.', output: false }];
    }
    return [{ text: `Note: ${asText(content)}`, output: false }];
  }
  return [
    { text: `${message.role === 'user' ? 'User' : 'Agent'}: ${asText(content)}`, output: false },
  ];
}

function toolOutput(result: ToolResultContent): string {
  if (result.edit !== undefined) {
    const { path, added, removed } = result.edit;
    return `(${result.name} changed ${path}: +${added} −${removed})`;
  }
  const lines = result.output ?? [];
  if (lines.length === 0) return '';
  const text = lines.join('\n');
  const capped = text.length > TOOL_OUTPUT_CAP ? `${text.slice(-TOOL_OUTPUT_CAP)}` : text;
  return `(output${result.ok ? '' : ', failed'})\n${capped}`;
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
