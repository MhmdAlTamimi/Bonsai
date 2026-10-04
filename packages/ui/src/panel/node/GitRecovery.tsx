import { type JSX, useState } from 'react';
import type { GitRecoveryView, SynchronizeAction } from '@bonsai/shared';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { DirectoryPicker } from '../DirectoryPicker.tsx';

export function GitRecovery({
  projectId,
  onChanged,
  recovery,
  busy,
  onSynchronize,
}: {
  projectId: string;
  onChanged: () => void;
  recovery: GitRecoveryView;
  busy: boolean;
  onSynchronize: (action: SynchronizeAction) => void;
}): JSX.Element {
  const [locating, setLocating] = useState(false);
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locate = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.locateRepository(projectId, path);
      onChanged();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="recover" aria-label="Synchronize Git and Bonsai">
      <p className="recover-headline">Sync Git and Bonsai</p>
      <p className="hint recover-detail">{recovery.message}</p>
      {['missing_repository', 'unreadable_repository'].includes(recovery.problem) && (
        <>
          <button disabled={busy || saving} onClick={() => setLocating((value) => !value)}>
            Locate repository
          </button>
          {locating && (
            <div>
              <p className="hint">
                Choose the repository’s new location. Bonsai checks its saved code and repairs
                experiment folders.
              </p>
              <DirectoryPicker value={path} onChange={setPath} markRepos />
              <button disabled={!path || saving} onClick={() => void locate()}>
                Use this repository
              </button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
      <details className="help-details">
        <summary>Version details</summary>
        <dl>
          <dt>Bonsai recorded</dt>
          <dd>{recovery.recordedCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
          <dt>Folder</dt>
          <dd>{recovery.folderCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
          <dt>Git saved</dt>
          <dd>{recovery.savedCommit?.slice(0, 10) ?? 'Unavailable'}</dd>
        </dl>
      </details>
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
            Restore Bonsai code
          </button>
        )}
      </div>
    </section>
  );
}
