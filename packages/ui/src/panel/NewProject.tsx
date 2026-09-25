import { type JSX, useEffect, useState } from 'react';
import type { DirectoryInspectionView, ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ErrorNote } from '../ErrorNote.tsx';
import { Icon } from '../Icon.tsx';
import { plural } from '../words.ts';
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
  projects = [],
}: {
  onCreated: (id: string, nodeId: string) => void;
  /** Only offered when there is a project to go back to. */
  onCancel?: () => void;
  /** Jump to a folder that turns out to already be in Bonsai. */
  onOpenExisting?: (projectId: string, nodeId: string | null) => void;
  initialMode?: 'new' | 'existing';
  projects?: readonly ProjectView[];
}): JSX.Element {
  const [mode, setMode] = useState<'new' | 'existing'>(initialMode);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [folder, setFolder] = useState('');
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [choosingLocation, setChoosingLocation] = useState(false);
  const [preview, setPreview] = useState<{ key: string; path: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectedFolder, setInspectedFolder] = useState('');
  const [inspectionRetry, setInspectionRetry] = useState(0);
  const [inspection, setInspection] = useState<DirectoryInspectionView | null>(null);
  const [createAnother, setCreateAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewKey = JSON.stringify([location, name.trim() || 'untitled']);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    if (location === '' || mode !== 'new') return;
    void api
      .previewProject(location, name.trim() || 'untitled')
      .then(({ path }) => {
        if (alive) setPreview({ key: previewKey, path });
      })
      .catch((e: unknown) => {
        if (alive) setPreviewError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [location, name, mode, previewKey, inspectionRetry]);

  // Look before adopting: whether it is a repo, what branch it is on and how
  // much is uncommitted all change what the user is agreeing to.
  useEffect(() => {
    setCreateAnother(false);
    setInspection(null);
    setInspectedFolder('');
    setInspectionError(null);
    setIncludeUncommitted(false);
    if (mode !== 'existing' || folder === '') {
      setInspection(null);
      return;
    }
    let alive = true;
    void api
      .inspect(folder)
      .then((i) => {
        if (alive) {
          setInspection(i);
          setInspectedFolder(folder);
        }
      })
      .catch((e: unknown) => {
        if (alive) setInspectionError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [mode, folder, inspectionRetry]);

  const submit = async (): Promise<void> => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const { projectId, masterNodeId } = await api.createProject({
          name: name.trim() || 'untitled',
          description,
          location,
          expectedPath: preview!.path,
        });
        onCreated(projectId, masterNodeId);
      } else {
        const { projectId, masterNodeId } = await api.adoptProject({
          path: folder,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          description,
          includeUncommitted,
        });
        onCreated(projectId, masterNodeId);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const currentInspection = inspectedFolder === folder ? inspection : null;
  const matching =
    currentInspection?.repoRoot == null
      ? []
      : projects.filter((project) => project.sourcePath === currentInspection.repoRoot);
  const offerExisting = matching.length > 0 && !createAnother;
  const blocked =
    mode === 'new'
      ? location === '' || preview?.key !== previewKey || choosingLocation
      : offerExisting ||
        folder === '' ||
        currentInspection?.blockedReason !== null ||
        currentInspection.knownTo !== null;

  return (
    <div className="new-project">
      <h1>
        <Logo size={26} /> {mode === 'new' ? 'New project' : 'Open a folder'}
      </h1>

      <div className="tabs project-source-switch" role="group" aria-label="Project source">
        <button
          aria-pressed={mode === 'new'}
          className={mode === 'new' ? 'on' : ''}
          onClick={() => setMode('new')}
        >
          <Icon name="plus" /> New project
        </button>
        <button
          aria-pressed={mode === 'existing'}
          className={mode === 'existing' ? 'on' : ''}
          onClick={() => setMode('existing')}
        >
          <Icon name="folderOpen" /> Open a folder
        </button>
      </div>

      {mode === 'new' ? (
        <>
          <p className="muted">Start fresh in a new project folder.</p>
          <label className="project-field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sales forecast"
              aria-label="project name"
            />
          </label>
          <label className="project-field">
            What should it build?
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the goal in a sentence or two"
              aria-label="project description"
              rows={4}
            />
          </label>
          <div className="stacked">
            <span>Project location</span>
            <p className="hint">
              {location === ''
                ? 'Choose a parent folder. Bonsai will create a new project subfolder inside it.'
                : `Parent folder: ${location}`}
            </p>
            <button type="button" onClick={() => setChoosingLocation((v) => !v)}>
              <Icon name="folderOpen" />
              {choosingLocation
                ? 'Close folder browser'
                : location
                  ? 'Change folder'
                  : 'Choose folder'}
            </button>
            {choosingLocation && (
              <DirectoryPicker
                value={location}
                onChange={(path) => {
                  setLocation(path);
                  if (path !== '') setChoosingLocation(false);
                }}
              />
            )}
            {preview?.key === previewKey && (
              <p className="note">New project folder: {preview.path}</p>
            )}
            {location !== '' && preview === null && previewError === null && (
              <p className="loading" role="status">
                Checking destination
              </p>
            )}
            {previewError !== null && (
              <ErrorNote onRetry={() => setInspectionRetry((n) => n + 1)}>{previewError}</ErrorNote>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted">Choose an existing repository or folder.</p>
          <DirectoryPicker value={folder} onChange={setFolder} markRepos />
          {folder !== '' && currentInspection === null && inspectionError === null && (
            <p className="loading" role="status">
              Inspecting selected folder
            </p>
          )}
          {inspectionError !== null && (
            <ErrorNote
              onRetry={() => setInspectionRetry((n) => n + 1)}
              retryLabel="Retry inspection"
            >
              {inspectionError}
            </ErrorNote>
          )}
          {matching.length > 0 && (
            <section className="matching-projects" aria-label="Projects in this repository">
              <h3>Existing projects</h3>
              {matching.map((project) => (
                <div className="existing-project-row" key={project.id}>
                  <Icon name="folderOpen" />
                  <div className="existing-project-identity">
                    <strong>{project.name}</strong>
                    <small>
                      {project.workDir || 'Repository root'} · {project.id.slice(0, 8)}
                    </small>
                  </div>
                  <button
                    aria-label={`Open project ${project.name}`}
                    onClick={() => onOpenExisting?.(project.id, null)}
                  >
                    Open project <Icon name="arrowRight" />
                  </button>
                </div>
              ))}
              {offerExisting && (
                <button className="linkish" onClick={() => setCreateAnother(true)}>
                  <Icon name="plus" /> Create another project here
                </button>
              )}
            </section>
          )}
          {!offerExisting && (
            <Inspected inspection={currentInspection} onOpenExisting={onOpenExisting} />
          )}

          {!offerExisting && currentInspection?.knownTo == null && (
            <>
              {currentInspection !== null && currentInspection.dirtyFiles > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={includeUncommitted}
                    onChange={(e) => setIncludeUncommitted(e.target.checked)}
                  />
                  <span>
                    Start experiments from your uncommitted work too (
                    {plural(currentInspection.dirtyFiles, 'file')}). Bonsai takes a snapshot commit
                    that belongs to no branch; your working folder is not touched either way.
                  </span>
                </label>
              )}

              <label className="project-field">
                Name (optional)
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    currentInspection?.path == null
                      ? 'Defaults to the folder name'
                      : basename(currentInspection.path)
                  }
                  aria-label="project name"
                />
              </label>
              <label className="project-field">
                What is this project? (optional)
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A sentence the agent can start from"
                  aria-label="project description"
                  rows={3}
                />
              </label>
            </>
          )}
        </>
      )}

      <div className="row project-actions">
        {!(mode === 'existing' && (offerExisting || currentInspection?.knownTo)) && (
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || blocked}
            aria-busy={busy}
          >
            {mode === 'new' ? 'Create project' : 'Create project from folder'}
          </button>
        )}
        {onCancel !== undefined && (
          <button className="linkish" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
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
            <Icon name="arrowRight" /> {nodeName ? 'Open experiment' : 'Open project'}
          </button>
        )}
      </div>
    );
  }

  if (inspection.blockedReason !== null) {
    return <p className="error">{inspection.blockedReason}</p>;
  }

  if (inspection.repoRoot === null) {
    return (
      <p className="note">
        Not a git repository, and not inside one. Bonsai will run <code>git init</code> here and
        make one commit of what is already in the folder — {plural(inspection.entryCount, 'item')} —
        so experiments have something to branch from.
        {inspection.entryCount > 400 &&
          ' That is a lot of files; check there is no build output or node_modules in there first.'}
      </p>
    );
  }

  return (
    <div className="note inspected">
      {/*
       * The two facts that are genuinely separate, said separately (D37).
       *
       * A folder inside a repository used to be refused with advice to pick the
       * root instead, which made a monorepo an all-or-nothing choice. It is
       * accepted now, so the form has to be explicit about which folder is
       * which: git still sees the whole repository, and the agent works in the
       * folder that was picked.
       */}
      <dl className="scope">
        <dt>Repository</dt>
        <dd>
          <code>{inspection.repoRoot}</code>
          {inspection.workDir !== '' && ' — its whole history, branches and commits'}
        </dd>
        <dt>Agent works in</dt>
        <dd>
          {inspection.workDir === '' ? 'the repository root' : <code>{inspection.workDir}</code>}
        </dd>
      </dl>
      {inspection.headCommit === null ? (
        <p>
          The repository has no commits yet. Bonsai will make the first one from what is in it,
          because a branch needs somewhere to start.
        </p>
      ) : (
        <p>
          On <strong>{inspection.branch ?? 'a detached HEAD'}</strong>, at{' '}
          <code>{inspection.headCommit.slice(0, 8)}</code>.{' '}
          {inspection.dirtyFiles > 0
            ? `${plural(inspection.dirtyFiles, 'uncommitted change')} — left exactly as they are.`
            : 'Clean.'}{' '}
          This branch becomes the starting experiment and stays read-only; experiments branch from
          it.
        </p>
      )}
      {inspection.workDir !== '' && (
        <p className="hint">
          Bonsai will not create a second repository inside this folder, and will not make a branch
          because you chose a subfolder. Commits, history and diffs stay whole-repository.
        </p>
      )}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
