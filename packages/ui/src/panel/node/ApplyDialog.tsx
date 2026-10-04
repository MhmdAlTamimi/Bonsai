import { type JSX, useEffect, useState } from 'react';
import { plural, type ApplyPatchView, type ChangeScope, type NodeView } from '@bonsai/shared';

import { CopyButton } from '../../CopyButton.tsx';
import { Dialog, DialogHeader } from '../../Dialog.tsx';
import { ErrorNote } from '../../ErrorNote.tsx';
import { Icon } from '../../Icon.tsx';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * Taking an experiment's changes to your own repository: one command, run by
 * you, or the same patch downloaded for a Git app. Bonsai writes the patch
 * into its own data folder when this opens -- fresh each time, since the
 * experiment may have moved on -- and never touches your repository.
 *
 * The whole line by default: your folder is at master's code, so the patch
 * has to carry what the experiment's parents did as well as its own step.
 *
 * Opened from the review screen and from a card's ⋯ menu; the same dialog in
 * both, so it says the same thing wherever you find it.
 */
export function ApplyDialog({
  node,
  onClose,
  returnFocus,
}: {
  node: NodeView;
  onClose: () => void;
  returnFocus?: string;
}): JSX.Element {
  const [scope, setScope] = useState<ChangeScope>('line');
  const [patch, setPatch] = useState<ApplyPatchView | null>(null);
  // Kept across a switch, so the choice does not vanish while the other loads.
  const [scopes, setScopes] = useState<ApplyPatchView['scopes']>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const exportCode = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      setExportPath((await api.exportNode(node.id)).path);
    } catch (error) {
      setExportError(describeError(error));
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    let alive = true;
    setPatch(null);
    setError(null);
    api
      .applyPatch(node.id, scope)
      .then((view) => {
        if (!alive) return;
        setPatch(view);
        setScopes(view.scopes);
      })
      .catch((e: unknown) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [node.id, scope]);

  return (
    <Dialog title="Apply to your repo" onClose={onClose} returnFocus={returnFocus}>
      <DialogHeader title="Apply to your repo" onClose={onClose} />
      {scopes !== null && (
        <div
          className="segmented-control review-scope apply-scope"
          role="group"
          aria-label="Changes to apply"
        >
          <button
            aria-pressed={scope === 'line'}
            title="Everything this experiment and its parents changed"
            onClick={() => setScope('line')}
          >
            Whole line <span className="scope-count">{scopes.line}</span>
          </button>
          <button
            aria-pressed={scope === 'own'}
            disabled={scopes.own === 0}
            title="Only this experiment's own step, for when its parents' changes are already in your folder"
            onClick={() => setScope('own')}
          >
            This experiment <span className="scope-count">{scopes.own}</span>
          </button>
        </div>
      )}
      {error !== null ? (
        <ErrorNote>{error}</ErrorNote>
      ) : patch === null ? (
        <p className="hint" role="status">
          Preparing the patch
        </p>
      ) : (
        <section className="apply-section" aria-label="Apply command">
          <p className="hint apply-stats">
            {plural(patch.files, 'file')} · +{patch.added.toLocaleString()} −
            {patch.removed.toLocaleString()}
          </p>
          {patch.folder !== null && (
            <p className="hint apply-target">
              Destination: <code>{patch.folder}</code>
            </p>
          )}
          <ol className="apply-steps">
            <li>
              <strong>Run in your terminal</strong>
              {patch.folder === null && <p className="hint">Open the target repository first.</p>}
              <div className="row">
                <code className="apply-command">{patch.command}</code>
                <CopyButton text={patch.command} label="Copy command" />
              </div>
            </li>
            <li>
              <strong>Review, then commit</strong>
              <div className="row">
                <code className="apply-command">git diff --staged</code>
                <CopyButton text="git diff --staged" label="Copy review command" />
              </div>
              <p className="hint">Resolve any conflicts before committing.</p>
            </li>
          </ol>
          {patch.branchMismatch !== null && (
            <p className="note">
              This project started from <strong>{patch.branchMismatch.startedFrom}</strong>, but
              your folder is on <strong>{patch.branchMismatch.folderOn}</strong>: the changes would
              land there.
            </p>
          )}
          {patch.behind !== null && (
            <p className="note">
              This experiment is {plural(patch.behind.commits, 'commit')} behind{' '}
              {patch.behind.parentName}, so applying it may conflict.
            </p>
          )}
          <p className="hint">
            Includes committed code only. Bonsai notes and unsaved changes are excluded.
          </p>
          <details className="help-details">
            <summary>Command results</summary>
            <p>
              A successful command may print nothing. Check the staged diff above. If Git reports an
              error, read it before retrying; keep your existing work intact.
            </p>
          </details>
          <div className="apply-download">
            <a href={api.patchFileUrl(node.id, scope)} download>
              <Icon name="apply" /> Download patch
            </a>
          </div>
        </section>
      )}
      <details className="help-details export-details">
        <summary>Export repository</summary>
        <section className="apply-section" aria-label="Independent repository export">
          <p className="hint">
            A standalone copy of saved code and Git history. Unsaved and ignored files are excluded;
            submodules must be accessible.
          </p>
          <button
            aria-label="Export full repository"
            disabled={exporting || exportPath !== null}
            onClick={() => void exportCode()}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          {exportError && <ErrorNote>{exportError}</ErrorNote>}
          {exportPath !== null && (
            <div className="row" role="status">
              <code className="path-value">{exportPath}</code>
              <CopyButton text={exportPath} label="Copy export folder" />
            </div>
          )}
        </section>
      </details>
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
