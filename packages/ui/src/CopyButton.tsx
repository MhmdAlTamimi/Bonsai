import { type JSX, useEffect, useRef, useState } from 'react';

import { IconButton } from './Icon.tsx';

/**
 * Copy, as one icon everywhere: a command, a code block, a checkout command,
 * a report. Four places each had their own -- a text button, a link, a glyph
 * -- with four different ways of saying it worked or did not.
 *
 * It widens to say what happened and then settles back; a failure stays,
 * because it is news, and it means the text is still only on the screen.
 */
export function CopyButton({
  text,
  label,
  className = '',
}: {
  text: string;
  /** What is copied, as the tooltip says it: "Copy command". */
  label: string;
  className?: string;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    clearTimeout(timer.current);
    setState('idle');
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setState('failed');
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => {
        setState('copied');
        // Long enough to notice, short enough not to become part of the page.
        timer.current = setTimeout(() => setState('idle'), 1_200);
      })
      .catch(() => setState('failed'));
  };
  return (
    <IconButton
      icon={state === 'copied' ? 'check' : 'copy'}
      label={label}
      title={state === 'failed' ? 'Copy failed. Select the text to copy it yourself.' : label}
      size="sm"
      className={`copy-button${state === 'idle' ? '' : ` ${state}`} ${className}`.trim()}
      onClick={copy}
    >
      {state === 'idle' ? null : (
        <span className="copy-label" role="status">
          {state === 'copied' ? 'Copied' : 'Copy failed'}
        </span>
      )}
    </IconButton>
  );
}
