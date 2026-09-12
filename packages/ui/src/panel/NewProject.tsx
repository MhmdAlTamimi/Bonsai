import { type JSX, useEffect, useState } from 'react';
import type { DirectoryInspectionView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Logo } from '../Logo.tsx';
import { DirectoryPicker } from './DirectoryPicker.tsx';

/**
 * Starting a project, the two ways it can start.
 *
 * NEW builds a fresh repository in a folder you choose, and Bonsai owns all of
 * it -- including deleting it later.
 *
 * EXISTING uses a folder you already have, in place. Nothing is copied and
 * nothing is moved: that folder becomes the project's repository, master is
 * that folder on the branch it is already on, and every node you make is an
 * ordinary `node/<uuid>` branch inside your own repo. The consequence worth
 * knowing is the one stated on the form: master is read-only, because writing
 * there would mean Bonsai committing to the branch you work on yourself.
 */
export function NewProject({
  onCreated,
  onCancel,
  onOpenExisting,
  initialMode = 'new',
}: {
  onCreated: (id: string) => void;
  /** Only offered when there is a project to go back to. */
  onCancel?: () => void;
  /** Jump to a folder that turns out to already be in Bonsai. */
  onOpenExisting?: (projectId: string, nodeId: string | null) => void;
  initialMode?: 'new' | 'existing';
}): JSX.Element {
  const [mode, setMode] = useState<'new' | 'existing'>(initialMode);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [folder, setFolder] = useState('');
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [inspection, setInspection] = useState<DirectoryInspectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Look before adopting: whether it is a repo, what branch it is on and how
  // much is uncommitted all change what the user is agreeing to.
  useEffect(() => {
    if (mode !== 'existing' || folder === '') {
      setInspection(null);
      return;
    }
    let alive = true;
    void api
      .inspect(folder)
      .then((i) => alive && setInspection(i))
      .catch(() => alive && setInspection(null));
    return () => {
      alive = false;
    };
  }, [mode, folder]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const { projectId } = await api.createProject({
          name: name.trim() || 'untitled',
          description,
          ...(location === '' ? {} : { location }),
        });
        onCreated(projectId);
      } else {
        const { projectId } = await api.adoptProject({
          path: folder,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          description,
          includeUncommitted,
        });
        onCreated(projectId);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = mode === 'existing' && (folder === '' || inspection?.blockedReason != null);

  return (
    <div className="new-project">
      <h1>
        <Logo size={26} /> {mode === 'new' ? 'New project' : 'Use an existing folder'}
      </h1>

      <div className="tabs">
        <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          New project
        </button>
        <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
          Use an existing folder
        </button>
      </div>

      {mode === 'new' ? (
        <>
          <p className="muted">
            Bonsai creates a repository, a master branch and a worktree in a folder of its own.
            Nothing touches any code you already have.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            aria-label="project name"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="what should it build?"
            aria-label="project description"
            rows={4}
          />
          <label className="stacked">
            <span>Where to put it</span>
            <DirectoryPicker value={location} onChange={setLocation} />
            <span className="hint">
              A new folder named after the project is created here. Leave it and Bonsai keeps the
              project in its own data directory.
            </span>
          </label>
        </>
      ) : (
        <>
          <p className="muted">
            Pick a folder you already have. It is used where it is — nothing is copied or moved.
            Your existing branches are left alone and do not become nodes.
          </p>
          <DirectoryPicker value={folder} onChange={setFolder} markRepos />
          <Inspected inspection={inspection} onOpenExisting={onOpenExisting} />

          {inspection !== null && inspection.dirtyFiles > 0 && (
            <label>
              <input
                type="checkbox"
                checked={includeUncommitted}
                onChange={(e) => setIncludeUncommitted(e.target.checked)}
              />
              <span>
                Start nodes from your uncommitted work too ({inspection.dirtyFiles} file
                {inspection.dirtyFiles === 1 ? '' : 's'}). Bonsai takes a snapshot commit that
                belongs to no branch; your working folder is not touched either way.
              </span>
            </label>
          )}

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              inspection?.path == null ? 'project name (optional)' : basename(inspection.path)
            }
            aria-label="project name"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="what is this project? (optional)"
            aria-label="project description"
            rows={3}
          />
        </>
      )}

      <div className="row">
        <button onClick={() => void submit()} disabled={busy || blocked}>
          {busy
            ? mode === 'new'
              ? 'Creating…'
              : 'Setting up…'
            : mode === 'new'
              ? 'Create project'
              : 'Use this folder'}
        </button>
        {onCancel !== undefined && (
          <button className="linkish" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

/** Says plainly what Bonsai found, so nothing about the folder is a surprise. */
function Inspected({
  inspection,
  onOpenExisting,
}: {
  inspection: DirectoryInspectionView | null;
  onOpenExisting?: (projectId: string, nodeId: string | null) => void;
}): JSX.Element {
  if (inspection === null) return <p className="hint">Choose a folder above.</p>;

  // Bonsai's own folder. Not an error -- you found something real, it just
  // already exists here, so the useful thing to offer is a way to it.
  if (inspection.knownTo !== null) {
    const { projectId, projectName, nodeId, nodeName } = inspection.knownTo;
    return (
      <div className="note">
        <p>
          This folder is{' '}
          {nodeName === null ? (
            <>
              part of your project <strong>{projectName}</strong>
            </>
          ) : (
            <>
              the node <strong>{nodeName}</strong> in your project <strong>{projectName}</strong>
            </>
          )}
          . It is already in Bonsai.
        </p>
        {onOpenExisting !== undefined && (
          <button className="linkish" onClick={() => onOpenExisting(projectId, nodeId)}>
            Open {nodeName ?? projectName}
          </button>
        )}
      </div>
    );
  }

  if (inspection.blockedReason !== null) {
    return <p className="error">{inspection.blockedReason}</p>;
  }

  if (!inspection.isGitRepo) {
    return (
      <p className="note">
        Not a git repository yet. Bonsai will run <code>git init</code> here and make one commit of
        what is already in the folder — {inspection.entryCount} item
        {inspection.entryCount === 1 ? '' : 's'} — so nodes have something to branch from.
        {inspection.entryCount > 400 &&
          ' That is a lot of files; check there is no build output or node_modules in there first.'}
      </p>
    );
  }

  if (inspection.headCommit === null) {
    return (
      <p className="note">
        A git repository with no commits yet. Bonsai will make the first one from what is in the
        folder, because a branch needs somewhere to start.
      </p>
    );
  }

  return (
    <p className="note">
      Git repository on <strong>{inspection.branch ?? 'a detached HEAD'}</strong>, at{' '}
      <code>{inspection.headCommit.slice(0, 8)}</code>.{' '}
      {inspection.dirtyFiles > 0
        ? `${inspection.dirtyFiles} uncommitted change${inspection.dirtyFiles === 1 ? '' : 's'} — left exactly as they are.`
        : 'Clean.'}{' '}
      This branch becomes master and stays read-only; nodes branch from it.
    </p>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
