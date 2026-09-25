import { type JSX, useCallback, useRef, useState } from 'react';
import type { ProjectView, SettingsView } from '@bonsai/shared';
import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Logo } from '../Logo.tsx';
import { useDismiss } from '../useDismiss.ts';

/**
 * The top bar: who this is, which project, and the way into settings.
 *
 * Deliberately almost empty. It used to carry the project menu, a Usage
 * button, a server-health indicator and the agent's model as a button — four
 * standing claims on the eye for things that change rarely or say the same
 * thing twice. Usage moved into the project's own menu; the agent's state is
 * said loudly, as a banner, exactly when it is not working.
 */
export function MenuBar({
  project,
  projects,
  settings,
  onError,
  onOpenProject,
  onStart,
  onOpenSettings,
  onOpenUsage,
  references,
  onOpenReferences,
  onDeleteProject,
}: {
  project: ProjectView | null;
  projects: ProjectView[];
  settings: SettingsView | null;
  onError: (message: string) => void;
  onOpenProject: (id: string) => void;
  /** Opens the start screen on one of its two halves. */
  onStart: (mode: 'new' | 'existing') => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  /** How many references the open project has, or null with no project open. */
  references: number | null;
  onOpenReferences: () => void;
  onDeleteProject: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<null | 'project'>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Click-away and Escape both close the menu, as any menu should. One shared
  // rule rather than a copy per menu -- see useDismiss.
  useDismiss(
    open !== null,
    useCallback(() => setOpen(null), []),
    barRef,
    '[aria-haspopup]',
  );

  const recent = projects.filter((p) => p.id !== project?.id);

  return (
    <div className="menubar" ref={barRef}>
      <span className="brand">
        <Logo size={22} />
        <span>Bonsai</span>
      </span>
      <span className="bar-divider" aria-hidden="true" />

      <div className="menu project-menu">
        <button
          className="menu-title project-picker"
          aria-label="Project"
          aria-haspopup="menu"
          aria-expanded={open === 'project'}
          title={project?.workPath ?? project?.sourcePath ?? project?.name}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen('project');
              requestAnimationFrame(() =>
                barRef.current
                  ?.querySelector<HTMLButtonElement>('[role="menu"] button:not(:disabled)')
                  ?.focus(),
              );
            }
          }}
          onClick={() => setOpen(open === 'project' ? null : 'project')}
        >
          <span className="project-picker-name">{project?.name ?? 'Choose project'}</span>
          <small className="project-location">
            {project?.sourcePath ?? ''}
            {project?.workDir ? ` · ${project.workDir}` : ''}
          </small>
          <Icon name="chevronDown" />
        </button>
        {open === 'project' && (
          <div
            className="menu-panel"
            role="menu"
            onKeyDown={(e) => {
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              );
              const i = items.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                items[
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                ]?.focus();
              }
              if (e.key === 'Tab') setOpen(null);
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setOpen(null);
                onStart('new');
              }}
            >
              New project…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(null);
                onStart('existing');
              }}
            >
              Use an existing folder…
            </button>

            <div className="menu-sep" />
            {/* This used to open the projects root whatever was selected, which
                was never the folder anyone meant. It opens THIS project's
                folder now -- the working folder, which is the repository root
                unless a subdirectory inside it was chosen (D37). */}
            <button
              role="menuitem"
              disabled={project?.workPath == null}
              title={project?.workPath ?? 'This project predates folder tracking.'}
              onClick={() => {
                setOpen(null);
                if (project?.workPath != null)
                  void api
                    .reveal(project.workPath)
                    .catch((e: unknown) => onError(describeError(e)));
              }}
            >
              Reveal this project in file manager
            </button>
            {project?.workDir !== undefined && project.workDir !== '' && (
              <button
                role="menuitem"
                disabled={project.sourcePath == null}
                title={project.sourcePath ?? ''}
                onClick={() => {
                  setOpen(null);
                  if (project.sourcePath != null)
                    void api
                      .reveal(project.sourcePath)
                      .catch((e: unknown) => onError(describeError(e)));
                }}
              >
                Reveal the repository folder
              </button>
            )}
            <button
              role="menuitem"
              disabled={settings === null}
              onClick={() => {
                setOpen(null);
                if (settings !== null)
                  void api
                    .reveal(settings.reposRoot)
                    .catch((e: unknown) => onError(describeError(e)));
              }}
            >
              Open managed repositories folder
            </button>

            <div className="menu-sep" />
            {/* Spend lives with the project it belongs to, rather than taking
                a permanent seat on the bar. */}
            <button
              role="menuitem"
              disabled={project === null}
              onClick={() => {
                setOpen(null);
                onOpenUsage();
              }}
            >
              Usage and cost…
            </button>

            <div className="menu-sep" />
            <div className="menu-label">All projects</div>
            {recent.length === 0 ? (
              <div className="menu-empty">No other projects</div>
            ) : (
              recent.map((p) => (
                <button
                  role="menuitem"
                  key={p.id}
                  onClick={() => {
                    setOpen(null);
                    onOpenProject(p.id);
                  }}
                >
                  <strong>{p.name}</strong>
                  <small>{p.sourcePath ?? 'Managed repository'}</small>
                  <small>
                    {p.workDir || 'Repository root'} · {p.id.slice(0, 8)}
                  </small>
                </button>
              ))
            )}

            <div className="menu-sep" />
            <button
              role="menuitem"
              className="danger"
              disabled={project === null}
              onClick={() => {
                setOpen(null);
                onDeleteProject();
              }}
            >
              Delete this project…
            </button>
          </div>
        )}
      </div>

      {/*
       * The repository's own branch, when there is one to name. A project
       * Bonsai created has only `node/<uuid>` branches, which D33 keeps out of
       * sight -- so it shows nothing rather than something meaningless.
       */}
      {project?.branchLabel != null && (
        <span className="branch-pill" title="The branch this project's folder is on">
          {project.branchLabel}
        </span>
      )}

      <span className="menubar-spacer" />
      {/* References are the project's shared text, used from every experiment,
          so they sit on the bar rather than in any one experiment's panel. */}
      {references !== null && (
        <button
          className="menu-title references-button"
          title="Text any experiment in this project can be given with @"
          onClick={onOpenReferences}
        >
          <Icon name="reference" />
          <span className="references-label">References</span>
          {references > 0 && <span className="references-count">{references}</span>}
        </button>
      )}
      <button
        className="menu-title settings-button"
        aria-label="Settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  );
}
