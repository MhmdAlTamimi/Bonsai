import { type JSX, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, ProjectView, SettingsView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Logo } from '../Logo.tsx';

/**
 * The application menu.
 *
 * Replaces the model/effort strip, which was a settings control wearing a
 * toolbar's clothes. Project and Settings both need a home now, and the two
 * pickers belong inside Settings rather than permanently on the canvas.
 */
export function MenuBar({
  project,
  projects,
  settings,
  connection,
  health,
  onError,
  onOpenProject,
  onStart,
  onOpenSettings,
  onDeleteProject,
}: {
  project: ProjectView | null;
  projects: Array<{ id: string; name: string }>;
  settings: SettingsView | null;
  connection: ConnectionStatus;
  health: 'connecting' | 'live' | 'reconnecting';
  onError: (message: string) => void;
  onOpenProject: (id: string) => void;
  /** Opens the start screen on one of its two halves. */
  onStart: (mode: 'new' | 'existing') => void;
  onOpenSettings: () => void;
  onDeleteProject: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<null | 'project'>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Click-away and Escape both close the menu, as any menu should.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(null);
        barRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const recent = projects.filter((p) => p.id !== project?.id).slice(0, 6);

  return (
    <div className="menubar" ref={barRef}>
      <span className="brand">
        <Logo size={36} />
        <span>Bonsai</span>
      </span>

      <div className="menu project-menu">
        <button
          className="menu-title project-picker"
          aria-label="Project"
          aria-haspopup="menu"
          aria-expanded={open === 'project'}
          title={project?.sourcePath ?? project?.name}
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
          <span className="project-picker-label">Project</span>
          <span className="project-picker-name">{project?.name ?? 'Choose project'}</span>
          <span aria-hidden="true">⌄</span>
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
                folder now -- master's checkout, wherever it happens to live. */}
            <button
              role="menuitem"
              disabled={project?.sourcePath == null}
              title={project?.sourcePath ?? 'This project predates folder tracking.'}
              onClick={() => {
                setOpen(null);
                if (project?.sourcePath != null)
                  void api
                    .reveal(project.sourcePath)
                    .catch((e: unknown) => onError(describeError(e)));
              }}
            >
              Reveal this project in file manager
            </button>
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
            <div className="menu-label">Recent</div>
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
                  {p.name}
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

      <span className="menubar-spacer" />
      <span
        className={`server-health health-${health}`}
        role="status"
        title="Connection to the local Bonsai server"
      >
        <span className="conn-dot" />
        {health === 'live' ? 'Live' : health === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
      </span>
      <button
        className={`conn conn-${connection.state}`}
        onClick={onOpenSettings}
        title={`Agent connection: ${connection.state}. Open settings.`}
      >
        {connection.model ?? connection.state.replace('_', ' ')}
      </button>
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
      {project !== null && project.costUsd > 0 && (
        <span
          className="menubar-cost"
          title="Estimated from token counts at list prices, across every run in this project. Not a bill."
        >
          ~${project.costUsd.toFixed(3)}
        </span>
      )}
    </div>
  );
}
