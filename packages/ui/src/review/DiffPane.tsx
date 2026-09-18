import { type JSX, useMemo } from 'react';
import type { ReviewFile } from '@bonsai/shared';

import { parsePatch } from '../panel/chat/diffModel.ts';

/**
 * One file's diff.
 *
 * The line is the unit: 21px, its number in a gutter, a sign column, then the
 * text — no wrapping, because a wrapped line of code stops being a line. A
 * hunk header says where in the file you are.
 */
export function DiffPane({
  file,
  patch,
  truncated,
  header,
  focused,
  onFocus,
}: {
  file: ReviewFile | null;
  patch: string | null;
  truncated?: boolean;
  /** The file header a split pane carries; the single pane names the file in the top bar. */
  header?: JSX.Element;
  focused?: boolean;
  onFocus?: () => void;
}): JSX.Element {
  const parsed = useMemo(() => (patch === null ? null : (parsePatch(patch)[0] ?? null)), [patch]);

  return (
    <section
      className={`diff-pane${focused === true ? ' focused' : ''}`}
      onPointerDown={onFocus}
      aria-label={file === null ? 'No file open' : `Changes in ${file.path}`}
    >
      {header}
      <div className="diff-scroll">
        {file === null ? (
          <p className="diff-note">Choose a file to read its changes.</p>
        ) : patch === null ? (
          <p className="diff-note" role="status">
            Loading {file.path}…
          </p>
        ) : file.binary || parsed?.binary === true ? (
          <p className="diff-note">Binary file — there is no text to show.</p>
        ) : parsed === null || parsed.lines.length === 0 ? (
          <p className="diff-note">
            {file.status === 'R'
              ? 'Renamed, with no change to its contents.'
              : 'No changed lines — only the file’s mode or metadata changed.'}
          </p>
        ) : (
          <>
            {parsed.lines.map((line, i) =>
              line.kind === 'hunk' ? (
                <div key={i} className="hunk">
                  <span className="hunk-range">{line.text}</span>
                  {file.status === 'A' || file.status === 'U' ? (
                    <span className="hunk-tag">new file</span>
                  ) : null}
                </div>
              ) : (
                <div key={i} className={`diff-line dl-${line.kind}`}>
                  <span className="diff-num">{line.newLine ?? line.oldLine ?? ''}</span>
                  <span className="diff-sign" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                  </span>
                  <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
                </div>
              ),
            )}
            {truncated === true && (
              <p className="diff-note">
                This file’s patch is too large to show in full — only its beginning is here.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
