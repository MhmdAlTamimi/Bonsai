import { type JSX, useMemo, useState } from 'react';
import type { ChangedFile } from '@bonsai/shared';

import { parsePatch } from '../chat/diffModel.ts';

/** Lines rendered at first, and added by each Show more. */
export const LINES_PER_PAGE = 1_000;

/**
 * One file's changed lines, with old and new line numbers.
 *
 * Only ever one file, in its own window -- never an accordion in a list. A
 * very large file renders its first thousand lines and offers the rest, so
 * opening a generated file does not freeze the page.
 */
export function DiffBody({
  file,
  patch,
  truncated,
}: {
  file: ChangedFile;
  patch: string;
  truncated: boolean;
}): JSX.Element {
  const parsed = useMemo(() => parsePatch(patch)[0] ?? null, [patch]);
  const [limit, setLimit] = useState(LINES_PER_PAGE);

  if (file.binary || parsed?.binary === true) {
    return <p className="hint diff-note">Binary file — there is no text to show.</p>;
  }
  if (parsed === null || parsed.lines.length === 0) {
    return (
      <p className="hint diff-note">
        {file.status === 'renamed'
          ? 'Renamed, with no change to its contents.'
          : 'No changed lines — only the file’s mode or metadata changed.'}
      </p>
    );
  }

  const remaining = parsed.lines.length - limit;
  return (
    <div className="diff-body" tabIndex={0} aria-label={`Changes in ${file.path}`}>
      {parsed.lines.slice(0, limit).map((line, i) => (
        <div key={i} className={`dl dl-${line.kind}`}>
          <span
            className="dl-number"
            aria-label={line.oldLine === undefined ? undefined : `Old line ${line.oldLine}`}
          >
            {line.oldLine ?? ''}
          </span>
          <span
            className="dl-number"
            aria-label={line.newLine === undefined ? undefined : `New line ${line.newLine}`}
          >
            {line.newLine ?? ''}
          </span>
          <span className="dl-mark" aria-hidden="true">
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
          </span>
          <span className="dl-text">{line.text === '' ? ' ' : line.text}</span>
        </div>
      ))}
      {remaining > 0 && (
        <button className="diff-more" onClick={() => setLimit((n) => n + LINES_PER_PAGE)}>
          Show {Math.min(remaining, LINES_PER_PAGE).toLocaleString()} more line
          {Math.min(remaining, LINES_PER_PAGE) === 1 ? '' : 's'} of {remaining.toLocaleString()}
        </button>
      )}
      {truncated && remaining <= 0 && (
        <p className="hint diff-note">
          This file’s patch is too large to show in full. Copy the patch to read the rest.
        </p>
      )}
    </div>
  );
}

/** Copies text, and says so -- or says why it could not. */
export function CopyButton({
  label,
  text,
}: {
  label: string;
  /** The text, or a way to fetch it when it is not loaded yet. */
  text: string | (() => Promise<string>);
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button
        className="linkish copy-button"
        onClick={() => {
          setState('idle');
          void (typeof text === 'string' ? Promise.resolve(text) : text())
            .then((value) => navigator.clipboard.writeText(value))
            .then(() => setState('copied'))
            .catch(() => setState('failed'));
        }}
      >
        {state === 'copied' ? 'Copied' : label}
      </button>
      {state === 'failed' && (
        <span role="alert" className="error copy-error">
          Could not copy. Retry, or select the text.
        </span>
      )}
    </>
  );
}
