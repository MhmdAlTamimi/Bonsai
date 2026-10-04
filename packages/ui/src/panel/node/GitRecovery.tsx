import type { JSX } from 'react';
import type { GitRecoveryView, SynchronizeAction } from '@bonsai/shared';

export function GitRecovery({
  recovery,
  busy,
  onSynchronize,
}: {
  recovery: GitRecoveryView;
  busy: boolean;
  onSynchronize: (action: SynchronizeAction) => void;
}): JSX.Element {
  return (
    <section className="recover" aria-label="Synchronize Git and Bonsai">
      <p className="recover-headline">Git and Bonsai need to be synchronized</p>
      <p className="hint recover-detail">{recovery.message}</p>
      <dl>
        <dt>Bonsai recorded</dt>
        <dd>{recovery.recordedCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
        <dt>Folder</dt>
        <dd>{recovery.folderCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
        <dt>Git saved</dt>
        <dd>{recovery.savedCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
      </dl>
      {recovery.changedFiles.length > 0 && (
        <details>
          <summary>Changed files ({recovery.changedFiles.length})</summary>
          <ul>
            {recovery.changedFiles.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="row">
        {recovery.canImportFolder && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => onSynchronize('import-folder')}
          >
            Import folder state
          </button>
        )}
        {recovery.canImportSaved && recovery.savedCommit !== recovery.folderCommit && (
          <button disabled={busy} onClick={() => onSynchronize('import-saved')}>
            Import Git saved code
          </button>
        )}
        {recovery.canRestore && (
          <button disabled={busy} onClick={() => onSynchronize('restore')}>
            Restore Bonsai recorded code
          </button>
        )}
      </div>
    </section>
  );
}
