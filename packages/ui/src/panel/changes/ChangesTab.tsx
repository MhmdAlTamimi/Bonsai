import { type JSX, useEffect, useState } from 'react';
import type { ChangedFile, ChangeScope, NodeView, RunView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { CopyButton } from './DiffBody.tsx';
import { FileTree } from './FileTree.tsx';
import { FILTER_FROM, filterFiles } from './fileTree.ts';
import { filesIn, useChangeSummary } from './useChanges.ts';

/**
 * What this experiment changed, as a tree of files (D44).
 *
 * Three views of the same experiment: every run's committed work together,
 * one run's own commit, or what is in the folder and not committed yet. A file
 * opens in a floating window over the map -- several side by side, as in an
 * editor -- rather than expanding here, so the list stays a list.
 */
export function ChangesTab({
  node,
  runs,
  scope,
  revision,
  openPaths,
  onScope,
  onOpen,
}: {
  node: NodeView;
  runs: readonly RunView[];
  scope: ChangeScope;
  revision: string;
  openPaths: ReadonlySet<string>;
  onScope: (scope: ChangeScope) => void;
  onOpen: (file: ChangedFile) => void;
}): JSX.Element {
  const summary = useChangeSummary(node.id, scope, revision);
  const [query, setQuery] = useState('');
  const [uncommittedCount, setUncommittedCount] = useState(0);

  // A summary still on screen from the scope before is not this scope's.
  const data =
    summary.data !== null &&
    (scope.kind === 'run' ? summary.data.runId === scope.runId : summary.data.scope === 'all')
      ? summary.data
      : null;
  useEffect(() => {
    if (data?.scope === 'all') setUncommittedCount(data.uncommitted.length);
  }, [data]);

  const files = data === null ? [] : filesIn(data, scope);
  const shown = filterFiles(files, query);
  const totals = {
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
  const committing = runs
    .map((run, index) => ({ run, number: index + 1 }))
    .filter(({ run }) => run.commitSha !== null);
  const value = scope.kind === 'run' ? `run:${scope.runId}` : scope.kind;

  return (
    <section className="changes-tab" aria-label="Changes">
      <div className="changes-bar">
        <select
          className="changes-scope"
          aria-label="Which changes"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            setQuery('');
            onScope(
              next === 'all' || next === 'uncommitted'
                ? { kind: next }
                : { kind: 'run', runId: next.slice('run:'.length) },
            );
          }}
        >
          <option value="all">All changes</option>
          {committing.map(({ run, number }) => (
            <option key={run.id} value={`run:${run.id}`}>
              Run {number} · {clock(run.startedAt)}
            </option>
          ))}
          {(uncommittedCount > 0 || scope.kind === 'uncommitted') && (
            <option value="uncommitted">Not committed yet ({uncommittedCount})</option>
          )}
        </select>
        {scope.kind !== 'uncommitted' && data !== null && files.length > 0 && (
          <CopyButton
            label="Copy patch"
            text={() =>
              (scope.kind === 'run' ? api.runDiff(scope.runId) : api.diff(node.id)).then(
                (diff) => diff.patch,
              )
            }
          />
        )}
      </div>

      {summary.error !== null && (
        <p className="error" role="alert">
          {data === null ? '' : 'These changes may be out of date. '}
          {summary.error} <button onClick={summary.retry}>Retry changes</button>
        </p>
      )}

      {data === null ? (
        summary.error === null && <p role="status">Loading changes…</p>
      ) : (
        <>
          <div className="changes-summary">
            <p className="changes-totals">
              <strong>
                {files.length} file{files.length === 1 ? '' : 's'}
              </strong>
              <span className="added">+{totals.added}</span>
              <span className="removed">−{totals.removed}</span>
            </p>
            <p className="changes-base">
              {scope.kind === 'uncommitted'
                ? 'Not committed yet, compared with the last commit.'
                : `Compared with ${lowerFirst(data.baseLabel)}.`}
            </p>
          </div>

          {scope.kind === 'all' && data.uncommitted.length > 0 && (
            <p className="note changes-uncommitted">
              {data.uncommitted.length} file{data.uncommitted.length === 1 ? ' is' : 's are'}{' '}
              changed in this experiment’s folder and not committed, so{' '}
              {data.uncommitted.length === 1 ? 'it is' : 'they are'} not included here.{' '}
              <button className="linkish" onClick={() => onScope({ kind: 'uncommitted' })}>
                Show {data.uncommitted.length === 1 ? 'it' : 'them'}
              </button>
            </p>
          )}

          {files.length > FILTER_FROM && (
            <input
              className="changes-filter"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Filter ${files.length} files`}
              aria-label="Filter changed files"
            />
          )}

          {files.length === 0 ? (
            <p className="hint">
              {scope.kind === 'run'
                ? 'This run changed no files.'
                : scope.kind === 'uncommitted'
                  ? 'Nothing is uncommitted.'
                  : 'No committed changes yet.'}
            </p>
          ) : shown.length === 0 ? (
            <p className="hint">No files match “{query.trim()}”.</p>
          ) : (
            <FileTree
              files={shown}
              label={`Changed files: ${files.length}`}
              openPaths={openPaths}
              expandAll={query.trim() !== ''}
              onOpen={onOpen}
            />
          )}
          <p className="hint changes-hint">
            Files open in windows over the map. Open several to read them side by side.
          </p>
        </>
      )}
    </section>
  );
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
