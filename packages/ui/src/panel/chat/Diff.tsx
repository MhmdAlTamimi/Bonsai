import { type JSX, useState } from 'react';
import { Dialog } from '../../Dialog.tsx';
import { parsePatch, patchTotals, shouldExpand, type DiffFile } from './diffModel.ts';

/** One patch, with file operations, line references, and a wider reading view. */
export function Diff({
  patch,
  dirty = [],
  allowExpand = true,
}: {
  patch: string;
  dirty?: readonly string[];
  allowExpand?: boolean;
}): JSX.Element {
  const files = parsePatch(patch);
  const totals = patchTotals(files);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="diff">
      {dirty.length > 0 && (
        <section className="diff-dirty" aria-label="Uncommitted files">
          <h4>Uncommitted work — excluded from this patch</h4>
          <ul>
            {dirty.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="hint">
            Includes new, untracked files. Review partial changes in the recovery notice when a run
            is stopped.
          </p>
        </section>
      )}
      {files.length === 0 ? (
        <p className="hint">No committed changes in this comparison.</p>
      ) : (
        <>
          <div className="diff-summary">
            <span>
              {totals.files} file{totals.files === 1 ? '' : 's'}
            </span>
            <span className="added">+{totals.added}</span>
            <span className="removed">−{totals.removed}</span>
            <CopyPatch patch={patch} />
            {allowExpand && (
              <button className="linkish" onClick={() => setExpanded(true)}>
                Expand changes
              </button>
            )}
          </div>
          {files.map((file, i) => (
            <FileBlock key={`${file.path}-${i}`} file={file} startOpen={shouldExpand(file, i)} />
          ))}
        </>
      )}
      {expanded && <ExpandedDiff patch={patch} dirty={dirty} onClose={() => setExpanded(false)} />}
    </div>
  );
}

function ExpandedDiff({
  patch,
  dirty,
  onClose,
}: {
  patch: string;
  dirty: readonly string[];
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog title="Changes" className="diff-dialog" onClose={onClose}>
      <header>
        <h2>Changes</h2>
        <button data-dialog-focus onClick={onClose}>
          Close changes
        </button>
      </header>
      <Diff patch={patch} dirty={dirty} allowExpand={false} />
    </Dialog>
  );
}

function FileBlock({ file, startOpen }: { file: DiffFile; startOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const operation = file.operation ?? 'modified';
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="diff-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="diff-path">
          {file.operation === 'renamed' && <>{file.oldPath} → </>}
          {file.path}
        </span>
        <span className="diff-operation">
          {operation[0]!.toUpperCase() + operation.slice(1)}
          {file.binary ? ' · Binary' : ''}
        </span>
        {!file.binary && (
          <span className="diff-counts">
            <span className="added">+{file.added}</span>{' '}
            <span className="removed">−{file.removed}</span>
          </span>
        )}
      </button>
      {open &&
        (file.binary ? (
          <p className="hint">Binary file changed. No text preview is available.</p>
        ) : file.lines.length === 0 ? (
          <p className="hint">File metadata changed; there are no changed text lines.</p>
        ) : (
          <div className="diff-body" tabIndex={0} aria-label={`Changes in ${file.path}`}>
            {file.lines.map((line, i) => (
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
                <span className="dl-text">{line.text === '' ? ' ' : line.text}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function CopyPatch({ patch }: { patch: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <button
        className="linkish diff-copy"
        onClick={() => {
          setError(false);
          void navigator.clipboard
            .writeText(patch)
            .then(() => setCopied(true))
            .catch(() => setError(true));
        }}
      >
        {copied ? 'Copied' : 'Copy patch'}
      </button>
      {error && (
        <span role="alert" className="error">
          Could not copy the patch. Retry or select the visible text.
        </span>
      )}
    </>
  );
}
