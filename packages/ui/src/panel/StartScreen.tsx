import type { JSX } from 'react';

import { NewProject } from './NewProject.tsx';
import type { ProjectSummary } from '../state/useProjectTree.ts';

/**
 * The full-screen state with no canvas behind it.
 *
 * Shown for two quite different reasons that need the same screen: there are
 * no projects yet, or the user asked for one. The difference is only whether
 * cancelling is offered — with nothing to go back to, a cancel button is a
 * dead end.
 */
export function StartScreen({
  mode,
  projects,
  currentProjectId,
  onOpen,
  onCreated,
  onSelectNode,
  onDone,
}: {
  mode: 'new' | 'existing';
  projects: readonly ProjectSummary[];
  currentProjectId: string | null;
  onOpen: (projectId: string) => void;
  /** A brand-new project: also refresh the list it now belongs to. */
  onCreated: (projectId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onDone: () => void;
}): JSX.Element {
  return (
    <div className="app single">
      <NewProject
        initialMode={mode}
        onCreated={(id) => {
          onDone();
          onCreated(id);
        }}
        onOpenExisting={(id, nodeId) => {
          onDone();
          if (nodeId !== null) onSelectNode(nodeId);
          onOpen(id);
        }}
        {...(projects.length > 0
          ? {
              onCancel: () => {
                onDone();
                const back = currentProjectId ?? projects[0]?.id ?? null;
                if (back !== null) onOpen(back);
              },
            }
          : {})}
      />
    </div>
  );
}
