import { type JSX, useCallback, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { PANEL_WIDTH, type NodeView } from '@bonsai/shared';

import { api } from './api/client.ts';
import { useSelection } from './state/selection.ts';
import { useConnection } from './state/useConnection.ts';
import { useProjectTree } from './state/useProjectTree.ts';
import { useRunStream } from './state/useRunStream.ts';
import { useChildCreation } from './state/useChildCreation.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Panel } from './panel/Panel.tsx';
import { StartScreen } from './panel/StartScreen.tsx';
import { NewChildDialog } from './canvas/NewChildDialog.tsx';
import { MenuBar } from './canvas/MenuBar.tsx';
import { SettingsDialog } from './panel/SettingsDialog.tsx';
import { ConnectionScreen } from './panel/ConnectionScreen.tsx';
import { PanelResizer } from './PanelResizer.tsx';

/**
 * Composition, and as little else as possible.
 *
 * This file used to hold twelve pieces of state, three async flows and all the
 * React Flow wiring, and every feature made it longer. Each concern now owns
 * itself — connection and settings, the project and its tree, the live event
 * stream, creating a child, the canvas — and what is left is which of them
 * talk to which.
 */
export function App(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((message: string) => setError(message), []);

  const { connection, settings, setSettings, reload } = useConnection();
  const projectTree = useProjectTree(report);
  const { projects, projectId, tree, noProjects } = projectTree;
  const selection = useSelection();
  const streams = useRunStream(projectId, projectTree.refresh);
  const child = useChildCreation({
    projectId,
    onCreated: selection.select,
    onError: report,
    refresh: projectTree.refresh,
  });

  const [showSettings, setShowSettings] = useState(false);
  /** Set when the user asked for the start screen, and which half of it. */
  const [startMode, setStartMode] = useState<'new' | 'existing' | null>(null);

  const selected: NodeView | null = tree?.nodes.find((n) => n.id === selection.primary) ?? null;
  const runningCount = tree?.nodes.filter((n) => n.status === 'running').length ?? 0;

  // Nothing works without a credential, so nothing is shown until there is one.
  if (connection.state !== 'connected') {
    return (
      <div className="app single">
        <ConnectionScreen status={connection} settings={settings} onChanged={reload} />
      </div>
    );
  }

  if (noProjects || startMode !== null) {
    return (
      <StartScreen
        mode={startMode ?? 'new'}
        projects={projects}
        currentProjectId={projectId}
        onOpen={projectTree.open}
        onCreated={projectTree.adopted}
        onSelectNode={selection.select}
        onDone={() => setStartMode(null)}
      />
    );
  }

  return (
    <div className="app">
      <div className="canvas">
        <MenuBar
          project={tree?.project ?? null}
          projects={projects}
          settings={settings}
          connection={connection}
          onOpenProject={(id) => {
            selection.clear();
            projectTree.open(id);
          }}
          onStart={(mode) => setStartMode(mode)}
          onOpenSettings={() => setShowSettings(true)}
          onDeleteProject={() => void projectTree.deleteCurrent()}
        />
        {error !== null && <div className="banner">{error}</div>}

        {/* Only when there is more than one, because with a single run in
            flight the card's own Stop is nearer and less ambiguous. */}
        {runningCount > 1 && (
          <button
            className="stop stop-all"
            onClick={() => {
              if (projectId !== null) {
                void api.cancelProject(projectId).then(projectTree.refresh);
              }
            }}
          >
            ■ Stop all {runningCount} runs
          </button>
        )}

        <Canvas
          nodes={tree?.nodes ?? []}
          onSelect={selection.select}
          onToggleSelect={selection.toggle}
          onMoved={(nodeId, position) => {
            void api
              .updateNode(nodeId, { positionX: position.x, positionY: position.y })
              .catch((e: unknown) => report(String(e)));
          }}
          onDropOnPane={child.begin}
        />
      </div>

      {showSettings && settings !== null && (
        <SettingsDialog
          settings={settings}
          connection={connection}
          project={tree?.project ?? null}
          selectedNodeId={selection.primary}
          onClose={() => setShowSettings(false)}
          onChanged={reload}
        />
      )}

      {child.pending !== null && (
        <NewChildDialog
          parentName={child.pending.parentName}
          onCancel={child.cancel}
          onCreate={child.create}
        />
      )}

      <PanelResizer
        width={settings?.panelWidth ?? PANEL_WIDTH.default}
        min={PANEL_WIDTH.min}
        max={PANEL_WIDTH.max}
        onCommit={(panelWidth) => {
          // Fire and forget: the width is already applied to the CSS variable,
          // so a failed save costs this session nothing and the next one a
          // default. Not worth a banner.
          void api
            .updateSettings({ panelWidth })
            .then(setSettings)
            .catch(() => undefined);
        }}
      />

      <Panel
        project={tree?.project ?? null}
        node={selected}
        stream={selected === null ? [] : (streams[selected.id] ?? [])}
        onChanged={projectTree.refresh}
      />
    </div>
  );
}

export function Root(): JSX.Element {
  return (
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  );
}
