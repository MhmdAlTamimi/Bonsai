import { type JSX, useRef } from 'react';

import { IconButton } from '../Icon.tsx';
import {
  clearSubmittedDraft,
  isSending,
  readAttachments,
  setSending,
  writeAttachments,
} from '../panel/chat/drafts.ts';
import { AttachedChips, useMentionMenu } from '../panel/chat/Mentions.tsx';
import { useDraft } from '../panel/chat/useDraft.ts';
import { useCanRun } from '../state/RunAvailability.ts';
import { useReferences } from '../state/references.ts';
import { useAutosize } from '../useAutosize.ts';

/** How many lines the box grows to before it scrolls inside itself, as in an experiment's. */
const MAX_LINES = 5;

/**
 * Where questions about the comparison are asked. The draft is kept per
 * comparison, like an experiment's, and while an answer is being written the
 * send button becomes Stop.
 *
 * `@` attaches references, as in an experiment's box -- a procedure to judge
 * by, criteria, an earlier finding. Not experiments: the comparison already
 * has its experiments, and pulling in another would blur what it compares.
 */
export function CompareComposer({
  projectId,
  comparisonId,
  running,
  disabled,
  onAsk,
  onStop,
}: {
  projectId: string;
  comparisonId: string;
  running: boolean;
  disabled: boolean;
  onAsk: (prompt: string, referenceIds: readonly string[]) => Promise<void>;
  onStop: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const { key, prompt, setPrompt, sending, attached, setAttached } = useDraft(
    projectId,
    comparisonId,
    'compare',
  );
  const references = useReferences();
  const box = useRef<HTMLTextAreaElement>(null);
  useAutosize(box, prompt, MAX_LINES);
  const mention = useMentionMenu({
    value: prompt,
    onChange: setPrompt,
    attached,
    onAttach: setAttached,
    box,
  });

  const send = (): void => {
    const text = prompt.trim();
    if (text === '' || running || disabled || !canRun || isSending(key)) return;
    setSending(key, true);
    // Only what still exists; a reference deleted since it was attached is dropped.
    const sent = attached.filter(
      (item) => item.kind === 'reference' && references.byId.has(item.id),
    );
    // Cleared only once it was asked; a failure keeps it, and says why above.
    void onAsk(
      text,
      sent.map((item) => item.id),
    )
      .then(() => {
        clearSubmittedDraft(key, prompt);
        writeAttachments(
          key,
          readAttachments(key).filter((item) => !sent.includes(item)),
        );
      })
      .catch(() => undefined)
      .finally(() => setSending(key, false));
  };

  return (
    <div className="composer compare-composer">
      <AttachedChips attached={attached} onAttach={setAttached} />
      {mention.menu}
      <textarea
        ref={box}
        value={prompt}
        rows={1}
        aria-label="question about these experiments"
        placeholder={
          running
            ? 'Write your next question — ask it when this answer finishes'
            : 'Ask about these experiments, or ask for a plan'
        }
        {...mention.textarea}
        onChange={(e) => {
          setPrompt(e.target.value);
          mention.moved(e.target);
        }}
        onKeyDown={(e) => {
          if (mention.keyDown(e)) return;
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-row">
        <span className="hint">
          {canRun ? 'Reads only · ⏎ ask · ⇧⏎ newline' : 'Reconnect the agent to ask'}
        </span>
        <IconButton
          icon="at"
          className="composer-mention"
          label="Attach a reference"
          title="Attach a reference (or type @)"
          onClick={mention.begin}
        />
        {running ? (
          <IconButton
            icon="stop"
            tone="danger"
            className="stop"
            label="Stop answering"
            onClick={onStop}
          />
        ) : (
          <IconButton
            icon="arrowUp"
            tone="accent"
            className="send"
            label="Ask"
            title="Ask (⏎)"
            aria-busy={sending}
            disabled={!canRun || disabled || sending || prompt.trim() === ''}
            onClick={send}
          />
        )}
      </div>
    </div>
  );
}
