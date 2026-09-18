import type { JSX } from 'react';

/**
 * The conversation, collapsed to a rail (D46).
 *
 * The panel used to disappear entirely, leaving a floating "Show experiment"
 * button over the map and no sign of which experiment it would show. A 46px
 * rail keeps the seam where it was, says who is in the thread, and is itself
 * the way back — so collapsing costs nothing to undo.
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
      title={`Show the conversation (⌘\\)`}
    >
      <span className="rail-chip" aria-hidden="true">
        ‹
      </span>
      <span className="rail-hairline" aria-hidden="true" />
      <span className="rail-who you" aria-hidden="true">
        YO
      </span>
      <span className="rail-who agent" aria-hidden="true">
        AI
      </span>
      <span className="spacer" />
      <span className="rail-key" aria-hidden="true">
        ⌘\
      </span>
    </button>
  );
}
