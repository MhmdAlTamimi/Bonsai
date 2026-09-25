import type { JSX, ReactNode } from 'react';

import { IconButton } from './Icon.tsx';

/**
 * Something went wrong, said in one line with what can be done about it.
 *
 * The same sentence-then-buttons shape was written out in a dozen places, and
 * drifted: a bordered "Dismiss" here, a "Retry" link there, a retry that was
 * a full button in the middle of the text. Now a retry is a word you can
 * press, and dismissing is the close icon every other dismissable thing has.
 */
export function ErrorNote({
  children,
  onRetry,
  retryLabel = 'Retry',
  onDismiss,
  className = '',
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  className?: string;
}): JSX.Element {
  return (
    <p className={`error error-note ${className}`.trim()} role="alert">
      <span className="error-text">{children}</span>
      {onRetry !== undefined && (
        <button className="linkish error-retry" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
      {onDismiss !== undefined && (
        <IconButton icon="close" label="Dismiss" size="xs" onClick={onDismiss} />
      )}
    </p>
  );
}
