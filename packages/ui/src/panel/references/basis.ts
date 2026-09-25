import type { DraftBasis } from '@bonsai/shared';

/** What a draft was written from, so a trimmed conversation is never a surprise. */
export function basisLine(basis: DraftBasis, from: string): string {
  const read =
    basis.messages === 0
      ? `Written from ${from}'s notes`
      : basis.included >= basis.messages
        ? `Written from all ${basis.messages} messages of ${from}`
        : `Written from ${basis.included} of ${basis.messages} messages of ${from} — the rest were left out to fit`;
  const extras = [
    basis.toolOutputOmitted ? 'tool output left out' : null,
    basis.notes && basis.messages > 0 ? 'with its CONTEXT.md notes' : null,
  ].filter((part) => part !== null);
  return `${read}${extras.length === 0 ? '' : ` (${extras.join(', ')})`}.`;
}
