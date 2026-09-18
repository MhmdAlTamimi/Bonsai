import type { JSX } from 'react';
import type { ToolResultContent } from '@bonsai/shared';

/**
 * What the agent ran, and what it changed.
 *
 * Two kinds in one shell, because they answer the same question at different
 * grain: RUN is a command and what it printed; EDIT is a file and the lines
 * that moved. Both stay short on purpose -- the transcript is read for the
 * shape of what happened, and the whole change is read in review.
 */
export function ToolBlock({
  name,
  detail,
  result,
  live,
}: {
  name: string;
  /** The command, or the file path: the one line that identifies the call. */
  detail: string;
  result: ToolResultContent | undefined;
  /** The call has not come back yet. */
  live: boolean;
}): JSX.Element {
  const edit = result?.edit;
  if (edit !== undefined) {
    return (
      <div className="tool-block">
        <header className="tool-head">
          <span className="tool-kind">EDIT</span>
          <span className="tool-subject" title={edit.path}>
            {edit.path}
          </span>
          <span className="added">+{edit.added}</span>
          <span className="removed">−{edit.removed}</span>
        </header>
        <div className="tool-body">
          {edit.lines.map((line, i) => (
            <div key={i} className={`tool-line dl-${line.kind}`}>
              <span className="tool-num">{line.newLine ?? line.oldLine ?? ''}</span>
              <span className="tool-sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
              <span className="tool-text">{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
          {edit.truncated === true && <p className="tool-more">…more changed lines in review</p>}
        </div>
      </div>
    );
  }

  const output = result?.output ?? [];
  return (
    <div className="tool-block">
      <header className="tool-head">
        <span className="tool-kind">{name === 'Bash' ? 'RUN' : name.toUpperCase()}</span>
        <span className="tool-subject" title={detail}>
          {detail}
        </span>
        {result !== undefined && (
          <span className={result.ok ? 'added' : 'removed'}>{result.ok ? 'exit 0' : 'failed'}</span>
        )}
      </header>
      {(output.length > 0 || live) && (
        <div className="tool-body">
          {output.map((line, i) => (
            <div key={i} className="tool-line">
              <span className="tool-gutter" aria-hidden="true">
                ›
              </span>
              <span className="tool-text">{line}</span>
            </div>
          ))}
          {live && output.length === 0 && (
            <div className="tool-line">
              <span className="tool-gutter" aria-hidden="true">
                ›
              </span>
              <span className="tool-text muted">running…</span>
            </div>
          )}
          {result?.dropped !== undefined && (
            <div className="tool-line">
              <span className="tool-gutter" aria-hidden="true">
                ›
              </span>
              <span className="tool-text muted">
                {result.dropped.toLocaleString()} more line{result.dropped === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
