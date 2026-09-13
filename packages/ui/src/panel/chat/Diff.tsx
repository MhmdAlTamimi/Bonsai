import { type JSX, useState } from 'react';

import { parsePatch, patchTotals, shouldExpand, type DiffFile } from './diffModel.ts';

/**
 * The diff, grouped by file and coloured by line.
 *
 * This is the artefact the node exists to produce, and it used to be one
 * undifferentiated `<pre>` capped at 260px: no colour, no file boundaries, no
 * counts, and horizontal scrolling through the lot. `git diff` in a terminal
 * was strictly better, which is not a comparison an interface should lose.
 *
 * Per-file collapse matters more than it sounds. A node's cumulative diff can
 * be thousands of lines, and the question being asked of it is usually "which
 * files did this touch" long before "what exactly changed in this one".
 */
export function Diff({
  patch,
  dirty = [],
}: {
  patch: string;
  dirty?: readonly string[];
}): JSX.Element {
  const files = parsePatch(patch);
  const totals = patchTotals(files);

  if (files.length === 0) {
    return <p className="hint">No textual changes.</p>;
  }

  return (
    <div className="diff">
      <div className="diff-summary">
        <span>
          {totals.files} file{totals.files === 1 ? '' : 's'}
        </span>
        <span className="added">+{totals.added}</span>
        <span className="removed">&minus;{totals.removed}</span>
        <CopyPatch patch={patch} />
      </div>
      {files.map((file, i) => (
        <FileBlock key={`${file.path}-${i}`} file={file} startOpen={shouldExpand(file, i)} />
      ))}
      {dirty.length > 0 && (
        <p className="hint">Uncommitted in this node&rsquo;s folder: {dirty.join(', ')}</p>
      )}
    </div>
  );
}

function FileBlock({ file, startOpen }: { file: DiffFile; startOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(startOpen);

  return (
    <div className="diff-file">
      <button
        className="diff-file-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={file.path}
      >
        <span className="diff-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="diff-path">{file.path}</span>
        {file.binary ? (
          <span className="hint">binary</span>
        ) : (
          <span className="diff-counts">
            <span className="added">+{file.added}</span>{' '}
            <span className="removed">&minus;{file.removed}</span>
          </span>
        )}
      </button>
      {open && !file.binary && (
        <div className="diff-body">
          {file.lines.map((line, i) => (
            <div key={i} className={`dl dl-${line.kind}`}>
              {/*
               * The marker is its own cell rather than part of the text, so a
               * copy of the visible lines does not pick up "+" and "-" -- and
               * so the gutter stays aligned when a line wraps.
               */}
              <span className="dl-mark" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
              </span>
              <span className="dl-text">{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyPatch({ patch }: { patch: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="linkish diff-copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(patch)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
      title="Copy the whole patch, ready for git apply"
    >
      {copied ? 'copied' : 'copy patch'}
    </button>
  );
}
