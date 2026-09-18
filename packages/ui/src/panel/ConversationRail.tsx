import type { JSX } from 'react';

/**
 * The conversation, collapsed to a rail (D46).
 *
 * The panel used to disappear entirely, leaving a floating "Show experiment"
 * button over the map and no sign of what it would show. The rail keeps the
 * seam where it was and is itself the way back, so collapsing costs nothing to
 * undo.
 *
 * It names the PANEL, not the people in it: the two participant chips said who
 * was talking in a conversation nobody can read while it is collapsed.
 */
export function ConversationRail({
  name,
  onOpen,
}: {
  /** The experiment whose conversation this is, for the button's label. */
  name: string | null;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      className="conversation-rail"
      onClick={onOpen}
      aria-label={name === null ? 'Show the conversation' : `Show the conversation for ${name}`}
      title={'Show the conversation (⌘\\)'}
    >
      <span className="rail-chip" aria-hidden="true">
        ‹
      </span>
      <span className="rail-hairline" aria-hidden="true" />
      <span className="rail-label" aria-hidden="true">
        CONVERSATION
      </span>
      <span className="rail-key" aria-hidden="true">
        ⌘\
      </span>
    </button>
  );
}
