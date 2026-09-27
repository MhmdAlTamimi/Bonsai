import { type JSX, useEffect, useState } from 'react';
import { plural, type ApplyPatchView, type NodeView } from '@bonsai/shared';

import { CopyButton } from '../../CopyButton.tsx';
import { Dialog, DialogHeader } from '../../Dialog.tsx';
import { ErrorNote } from '../../ErrorNote.tsx';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * Taking an experiment's changes to your own repository: one command, run by
 * you. Bonsai writes the patch into its own data folder when this opens --
 * fresh each time, since the experiment may have moved on -- and never touches
 * your repository.
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
  const [patch, setPatch] = useState<ApplyPatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .applyPatch(node.id)
      .then((view) => {
        if (alive) setPatch(view);
      })
      .catch((e: unknown) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [node.id]);

  return (
    <Dialog title="Apply to your repo" onClose={onClose} returnFocus={returnFocus}>
      <DialogHeader title="Apply to your repo" onClose={onClose} />
      {error !== null ? (
        <ErrorNote>{error}</ErrorNote>
      ) : patch === null ? (
        <p className="hint" role="status">
          Preparing the patch
        </p>
      ) : (
        <section className="apply-section" aria-label="Apply command">
          <div className="row">
            <code className="apply-command">{patch.command}</code>
            <CopyButton text={patch.command} label="Copy command" />
          </div>
          <p className="hint">
            Run this in your repository&rsquo;s folder. The changes land uncommitted: review them
            with <code>git diff --staged</code>, then commit them yourself. Git refuses to change a
            file that has uncommitted changes of your own, and if your code changed the same lines,
            it leaves conflict markers for you to resolve.
          </p>
          <p className="hint apply-stats">
            {plural(patch.files, 'file')} · +{patch.added.toLocaleString()} −
            {patch.removed.toLocaleString()} · excludes Bonsai&rsquo;s CONTEXT.md and any
            uncommitted work
          </p>
          {patch.behind !== null && (
            <p className="note">
              This experiment is {plural(patch.behind.commits, 'commit')} behind{' '}
              {patch.behind.parentName}, so applying it may conflict.
            </p>
          )}
        </section>
      )}
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
