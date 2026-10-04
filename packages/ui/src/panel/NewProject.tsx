import { type JSX, useEffect, useState } from 'react';
import type { DirectoryInspectionView, ProjectView, StartPointView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ErrorNote } from '../ErrorNote.tsx';
import { Icon } from '../Icon.tsx';
import { plural } from '../words.ts';
import { Logo } from '../Logo.tsx';
import { DirectoryPicker } from './DirectoryPicker.tsx';
import { relativeTime } from './chat/time.ts';

/**
 * Starting a project, the two ways it can start.
 *
 * FRESH builds a new repository in a folder you choose, and Bonsai owns all of
 * it -- including deleting it later.
 *
 * FROM A FOLDER starts from one version of a repository you already have: the
 * branch the folder is on, or any other branch, remote branch or tag. Master
 * is a read-only copy of that version and every experiment works on a copy of
 * its own, so the folder is only read. The one thing worth saying on the form
 * is the consequence: the project does not follow later changes in the folder.
 *
 * Written for someone who has never seen Bonsai: one line per choice, and
 * detail only where a decision needs it.
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
  const [startFrom, setStartFrom] = useState<string | null>(null);
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
    setStartFrom(null);
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
          includeUncommitted: includeUncommitted && start?.current === true,
          ...(start === null ? {} : { startFrom: start.ref }),
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
  const points = currentInspection?.startPoints ?? [];
  // What the folder has checked out, unless another version was picked.
  const start = points.find((p) => p.ref === startFrom) ?? points.find((p) => p.current) ?? null;
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
      <header className="start-brand">
        <Logo size={64} />
        <h1>Bonsai</h1>
        <p>Try ideas with Claude side by side, then keep the best one.</p>
      </header>

      <div
        className="tabs project-source-switch"
        role="group"
        aria-label="Project source"
        data-mode={mode}
      >
        <span className="project-source-fill" aria-hidden="true" />
        <button
          aria-pressed={mode === 'new'}
          className={mode === 'new' ? 'on' : ''}
          onClick={() => setMode('new')}
        >
          <Icon name="plus" /> Start fresh
        </button>
        <button
          aria-pressed={mode === 'existing'}
          className={mode === 'existing' ? 'on' : ''}
          onClick={() => setMode('existing')}
        >
          <Icon name="folderOpen" /> Start from a folder
        </button>
      </div>
      <p className="muted source-line">
        {mode === 'new'
          ? 'Bonsai makes a new folder, and Claude builds from scratch.'
          : 'Experiments work on a copy of your code. Your folder is never changed.'}
      </p>

      {mode === 'new' ? (
        <>
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
              rows={3}
            />
          </label>
          <div className="stacked">
            <span>Where</span>
            <p className="hint">
              {location === ''
                ? 'Bonsai makes the project folder inside the folder you choose.'
                : `Inside ${location}`}
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
            {preview?.key === previewKey && <p className="note">New folder: {preview.path}</p>}
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
          <DirectoryPicker value={folder} onChange={setFolder} markRepos />
          {folder !== '' && currentInspection === null && inspectionError === null && (
            <p className="loading" role="status">
              Looking at the folder
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
              <h3>Already in Bonsai</h3>
              {matching.map((project) => (
                <div className="existing-project-row" key={project.id}>
                  <Icon name="folderOpen" />
                  <div className="existing-project-identity">
                    <strong>{project.name}</strong>
                    <small>
                      {project.branchLabel === null ? 'Started' : `From ${project.branchLabel}`},{' '}
                      {relativeTime(project.createdAt)}
                      {project.workDir === '' ? '' : ` · works in ${project.workDir}`}
                    </small>
                  </div>
                  <button
                    aria-label={`Open project ${project.name}`}
                    onClick={() => onOpenExisting?.(project.id, null)}
                  >
                    Open <Icon name="arrowRight" />
                  </button>
                </div>
              ))}
              {offerExisting && (
                <button className="linkish" onClick={() => setCreateAnother(true)}>
                  <Icon name="plus" /> New project from the current code
                </button>
              )}
            </section>
          )}
          {!offerExisting && (
            <Inspected
              inspection={currentInspection}
              start={start}
              onStartFrom={(ref) => {
                setStartFrom(ref);
                if (!points.find((p) => p.ref === ref)?.current) setIncludeUncommitted(false);
              }}
              includeUncommitted={includeUncommitted}
              onIncludeUncommitted={setIncludeUncommitted}
              onOpenExisting={onOpenExisting}
            />
          )}

          {!offerExisting && currentInspection !== null && currentInspection.knownTo === null && (
            <>
              <label className="project-field">
                Name (optional)
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={basename(currentInspection.path)}
                  aria-label="project name"
                />
              </label>
              <label className="project-field">
                What is this project? (optional)
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A sentence Claude can start from"
                  aria-label="project description"
                  rows={2}
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
            Create project
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

/** Says what Bonsai found, and asks the one question left: which version to start from. */
function Inspected({
  inspection,
  start,
  onStartFrom,
  includeUncommitted,
  onIncludeUncommitted,
  onOpenExisting,
}: {
  inspection: DirectoryInspectionView | null;
  start: StartPointView | null;
  onStartFrom: (ref: string) => void;
  includeUncommitted: boolean;
  onIncludeUncommitted: (include: boolean) => void;
  onOpenExisting?: (projectId: string, nodeId: string | null) => void;
}): JSX.Element | null {
  if (inspection === null) return null;

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
              the experiment <strong>{nodeName}</strong> in your project{' '}
              <strong>{projectName}</strong>
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

  // The first snapshot is made in managed storage, without changing this folder.
  if (inspection.repoRoot === null || start === null) {
    return (
      <p className="note">
        Bonsai will save a copy as its first version, leaving your folder unchanged. Your .gitignore
        rules apply; common credentials, dependency folders and build output are excluded. Review
        the copied files before running an experiment.
      </p>
    );
  }

  const groups: Array<[StartPointView['kind'], string]> = [
    ['commit', 'Checked out'],
    ['branch', 'Branches'],
    ['remote', 'Remote branches'],
    ['tag', 'Tags'],
  ];
  return (
    <div className="note inspected">
      <label className="start-from">
        <span>Start from</span>
        <select
          value={start.ref}
          onChange={(e) => onStartFrom(e.target.value)}
          aria-label="start from"
        >
          {groups.map(([kind, label]) => {
            const options = inspection.startPoints.filter((p) => p.kind === kind);
            return options.length === 0 ? null : (
              <optgroup key={kind} label={label}>
                {options.map((p) => (
                  <option key={p.ref} value={p.ref}>
                    {p.name}
                    {p.current ? ' (checked out)' : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <small title={start.commit}>
          {start.commit.slice(0, 7)} · {relativeTime(start.date)}
        </small>
      </label>
      {start.current && inspection.dirtyFiles > 0 && (
        <label className="include-unsaved">
          <input
            type="checkbox"
            checked={includeUncommitted}
            onChange={(e) => onIncludeUncommitted(e.target.checked)}
          />
          <span>Include my {plural(inspection.dirtyFiles, 'unsaved change')}</span>
        </label>
      )}
      <p className="hint">
        Experiments start from this exact version. Later changes in your folder won&rsquo;t appear.
      </p>
      {inspection.workDir !== '' && (
        <p className="hint">
          Claude works in <code>{inspection.workDir}</code>; commits cover the whole repository.
        </p>
      )}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
