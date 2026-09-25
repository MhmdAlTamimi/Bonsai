import type { JSX } from 'react';
export function SaveFeedback({
  state,
  error,
}: {
  state: 'idle' | 'saving' | 'saved' | 'failed';
  error: string | null;
}): JSX.Element {
  return (
    <span
      className={`${error ? 'error' : 'hint'} save-feedback${state === 'saving' ? ' loading' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {state === 'saving'
        ? 'Saving'
        : state === 'saved'
          ? 'Saved'
          : state === 'failed'
            ? `Could not confirm save. ${error}`
            : ''}
    </span>
  );
}
