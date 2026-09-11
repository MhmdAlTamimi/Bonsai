import { type JSX, useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, ProjectView, SettingsView } from '@bonsai/shared';
import { api } from '../api/client.ts';
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
  onOpenProject,
  onStart,
  onOpenSettings,
  onDeleteProject,
}: {
  project: ProjectView | null;
  projects: Array<{ id: string; name: string }>;
  settings: SettingsView | null;
  connection: ConnectionStatus;
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
      if (e.key === 'Escape') setOpen(null);
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
        <Logo size={20} />
      </span>

      <div className="menu">
        <button className="menu-title" onClick={() => setOpen(open === 'project' ? null : 'project')}>
          Project
        </button>
        {open === 'project' && (
          <div className="menu-panel" role="menu">
            <button onClick={() => { setOpen(null); onStart('new'); }}>New project…</button>
            <button onClick={() => { setOpen(null); onStart('existing'); }}>
              Use an existing folder…
            </button>

            <div className="menu-sep" />
            {/* This used to open the projects root whatever was selected, which
                was never the folder anyone meant. It opens THIS project's
                folder now -- master's checkout, wherever it happens to live. */}
            <button
              disabled={project?.sourcePath == null}
              title={project?.sourcePath ?? 'This project predates folder tracking.'}
              onClick={() => {
                setOpen(null);
                if (project?.sourcePath != null) void api.reveal(project.sourcePath);
              }}
            >
              Reveal this project in file manager
            </button>
            <button
              disabled={settings === null}
              onClick={() => {
                setOpen(null);
                if (settings !== null) void api.reveal(settings.reposRoot);
              }}
            >
              Open Bonsai's data folder
            </button>

            <div className="menu-sep" />
            <div className="menu-label">Recent</div>
            {recent.length === 0 ? (
              <div className="menu-empty">No other projects</div>
            ) : (
              recent.map((p) => (
                <button key={p.id} onClick={() => { setOpen(null); onOpenProject(p.id); }}>
                  {p.name}
                </button>
              ))
            )}

            <div className="menu-sep" />
            <button
              className="danger"
              disabled={project === null}
              onClick={() => { setOpen(null); onDeleteProject(); }}
            >
              Delete this project…
            </button>
          </div>
        )}
      </div>

      <button className="menu-title" onClick={onOpenSettings}>
        Settings
      </button>

      {project !== null && (
        <span
          className="menubar-project"
          title={project.sourcePath ?? project.name}
        >
          {project.name}
          {project.sourceKind === 'adopted' && (
            <span className="pill tiny" title="Your own folder, used in place.">
              your folder
            </span>
          )}
        </span>
      )}

      <span className="menubar-spacer" />

      {/* Connection is worth a permanent indicator: it is the one thing that
          stops everything else working. */}
      <button className={`conn conn-${connection.state}`} onClick={onOpenSettings}>
        <span className="conn-dot" />
        {connection.state === 'connected'
          ? (connection.model ?? 'connected')
          : connection.state.replace('_', ' ')}
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
