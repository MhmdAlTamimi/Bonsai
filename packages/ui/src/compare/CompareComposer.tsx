import { type JSX, useLayoutEffect, useRef } from 'react';

import { Icon } from '../Icon.tsx';
import { clearSubmittedDraft, isSending, setSending } from '../panel/chat/drafts.ts';
import { useDraft } from '../panel/chat/useDraft.ts';
import { useCanRun } from '../state/RunAvailability.ts';

/** How many lines the box grows to before it scrolls inside itself, as in an experiment's. */
const MAX_LINES = 5;

/**
 * Where questions about the comparison are asked. The draft is kept per
 * comparison, like an experiment's, and while an answer is being written the
 * send button becomes Stop.
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
  onAsk: (prompt: string) => Promise<void>;
  onStop: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const { key, prompt, setPrompt, sending } = useDraft(projectId, comparisonId, 'compare');
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const style = getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.round(line * MAX_LINES + padding))}px`;
  }, [prompt]);

  const send = (): void => {
    const text = prompt.trim();
    if (text === '' || running || disabled || !canRun || isSending(key)) return;
    setSending(key, true);
    // Cleared only once it was asked; a failure keeps it, and says why above.
    void onAsk(text)
      .then(() => clearSubmittedDraft(key, prompt))
      .catch(() => undefined)
      .finally(() => setSending(key, false));
  };

  return (
    <div className="composer compare-composer">
      <textarea
        ref={box}
        value={prompt}
        rows={1}
        aria-label="question about these experiments"
        placeholder={
          running ? 'The agent is answering…' : 'Ask about these experiments, or ask for a plan…'
        }
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
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
        {running ? (
          <button className="secondary" onClick={onStop}>
            <Icon name="finished" /> Stop
          </button>
        ) : (
          <button
            className="primary"
            aria-label="Ask"
            disabled={!canRun || disabled || sending || prompt.trim() === ''}
            onClick={send}
          >
            <span className="send-label">{sending ? 'Asking…' : 'Ask'}</span>
            <span className="send-arrow" aria-hidden="true">
              ↑
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
