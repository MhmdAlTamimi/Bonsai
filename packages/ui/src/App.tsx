import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { PANEL_WIDTH, type NodeView } from '@bonsai/shared';

import { RunAvailability } from './state/RunAvailability.ts';
import { api } from './api/client.ts';
import { describeError } from './api/describeError.ts';
import { useSelection } from './state/selection.ts';
import { useConnection } from './state/useConnection.ts';
import { useProjectTree } from './state/useProjectTree.ts';
import { useRunStream } from './state/useRunStream.ts';
import { readAddress, useAddressBar } from './state/useAddressBar.ts';
import { useChildCreation } from './state/useChildCreation.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { Panel } from './panel/Panel.tsx';
import { StartScreen } from './panel/StartScreen.tsx';
import { NewChildDialog } from './canvas/NewChildDialog.tsx';
import { MenuBar } from './canvas/MenuBar.tsx';
import { UsageDialog } from './panel/UsageDialog.tsx';
import { SettingsDialog } from './panel/SettingsDialog.tsx';
import { ConnectionScreen } from './panel/ConnectionScreen.tsx';
import { PanelResizer } from './PanelResizer.tsx';
import { RunControls, StopAll } from './state/RunControls.tsx';
import { useConfirm } from './ConfirmDialog.tsx';

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

  const {
    connection,
    settings,
    setSettings,
    reload,
    error: connectionError,
    checking,
  } = useConnection();
  // One confirmation dialog for the whole app, so nothing falls back to the
  // browser's own modal. Project deletion asks through it; node deletion has
  // its own, rendered inside the panel.
  const confirm = useConfirm();
  // Read before anything can overwrite it: startup writes to the address bar
  // within a tick, so asking later returns what the app just put there.
  const arrivedAt = useRef(readAddress()).current;
  const projectTree = useProjectTree(report, confirm.ask, arrivedAt.projectId);
  const { projects, projectId, tree, noProjects } = projectTree;
  const selection = useSelection();
  useAddressBar({ projectId, nodeId: selection.primary });
  const live = useRunStream(projectId, projectTree.refresh);
  useEffect(() => {
    reload();
  }, [live.revision, reload]);
  const child = useChildCreation({
    projectId,
    onCreated: selection.select,
    onError: report,
    refresh: projectTree.refresh,
  });

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'app' | 'project'>('app');
  const [showUsage, setShowUsage] = useState(false);
  const openProjectSettings = (): void => {
    setSettingsTab('project');
    setShowSettings(true);
  };
  const settingsChanged = (): void => {
    reload();
    projectTree.refresh();
  };
  /** Set when the user asked for the start screen, and which half of it. */
  const [startMode, setStartMode] = useState<'new' | 'existing' | null>(null);

  /**
   * Restore the node named in the URL, once, when its tree arrives.
   *
   * Guarded by a ref rather than by "is nothing selected", which would keep
   * re-selecting it every time the user clicked the canvas background.
   * An id that is not in the tree is simply not selected -- a stale link
   * lands you in the right project with nothing chosen, which is recoverable.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || tree === null || arrivedAt.nodeId === null) return;
    restored.current = true;
    if (tree.nodes.some((n) => n.id === arrivedAt.nodeId)) selection.select(arrivedAt.nodeId);
  }, [tree, arrivedAt.nodeId, selection]);

  const selected: NodeView | null = tree?.nodes.find((n) => n.id === selection.primary) ?? null;

  if (connection.state === 'unknown' && projects.length === 0)
    return (
      <div className="app single">
        <div className="connect" role="status">
          {connectionError ?? 'Checking connection…'}
          {!checking && <button onClick={reload}>Retry connection</button>}
        </div>
      </div>
    );
  if (connection.state !== 'connected' && (noProjects || startMode !== null)) {
    return (
      <div className="app single">
        <ConnectionScreen status={connection} settings={settings} onChanged={reload} />
        {!noProjects && (
          <button onClick={() => setStartMode(null)}>Back to saved experiments</button>
        )}
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
    <RunAvailability.Provider value={connection.state === 'connected'}>
      <RunControls nodes={tree?.nodes ?? []} onChanged={projectTree.refresh}>
        <div className="app">
          <div className="canvas">
            <MenuBar
              project={tree?.project ?? null}
              projects={projects}
              settings={settings}
              connection={connection}
              health={live.health}
              onError={report}
              onOpenProject={(id) => {
                selection.clear();
                projectTree.open(id);
              }}
              onStart={(mode) => setStartMode(mode)}
              onOpenSettings={() => {
                setSettingsTab('app');
                setShowSettings(true);
              }}
              onOpenUsage={() => setShowUsage(true)}
              onDeleteProject={() =>
                void projectTree.deleteCurrent().catch((e: unknown) => report(describeError(e)))
              }
            />
            {connection.state !== 'connected' && (
              <div className="transport-notice" role="status">
                Agent unavailable · Saved experiments are available.{' '}
                <button
                  onClick={() => {
                    setSettingsTab('app');
                    setShowSettings(true);
                  }}
                >
                  Reconnect agent
                </button>
              </div>
            )}
            {error !== null && (
              <div className="banner" role="alert">
                {error} <button onClick={() => setError(null)}>Dismiss</button>
              </div>
            )}
            {connectionError !== null && (
              <div className="banner" role="alert">
                {connectionError} <button onClick={reload}>Retry connection</button>
              </div>
            )}
            {live.health === 'reconnecting' && (
              <div className="transport-notice" role="status">
                Reconnecting to Bonsai… Showing last received state.
              </div>
            )}
            {projectTree.error !== null ? (
              <div className="tree-notice" role="alert">
                {tree !== null && 'Project updates unavailable. '}
                {projectTree.error} <button onClick={projectTree.retry}>Retry project</button>
              </div>
            ) : projectTree.loading && tree === null ? (
              <div className="tree-notice" role="status">
                Loading project…
              </div>
            ) : null}
            <StopAll nodes={tree?.nodes ?? []} />

            <Canvas
              nodes={tree?.nodes ?? []}
              selectedId={selection.primary}
              onSelect={selection.select}
              onToggleSelect={selection.toggle}
              onMoved={(nodeId, position) => {
                void api
                  .updateNode(nodeId, { positionX: position.x, positionY: position.y })
                  .catch((e: unknown) => report(describeError(e)));
              }}
              onDropOnPane={child.begin}
            />
          </div>

          {showSettings && settings !== null && (
            <SettingsDialog
              initialTab={settingsTab}
              settings={settings}
              connection={connection}
              project={tree?.project ?? null}
              selectedNodeId={selection.primary}
              onClose={() => setShowSettings(false)}
              onChanged={settingsChanged}
            />
          )}

          {showUsage && tree !== null && (
            <UsageDialog
              key={projectId}
              projectId={tree.project.id}
              projectName={tree.project.name}
              revision={live.revision}
              onClose={() => setShowUsage(false)}
              onSelect={selection.select}
            />
          )}

          {child.pending !== null && (
            <NewChildDialog
              parentName={child.pending.parentName}
              parentId={child.pending.parentId}
              onSelectSource={selection.select}
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
            startError={
              child.failedStart?.nodeId === selected?.id
                ? (child.failedStart?.message ?? null)
                : null
            }
            onRunStarted={() => {
              if (selected !== null) child.clearStartError(selected.id);
            }}
            stream={selected === null ? [] : (live.streams[selected.id] ?? [])}
            streamRevision={live.revision}
            onProjectSettings={openProjectSettings}
            onChanged={projectTree.refresh}
            /* The panel does not own a second, weaker version of this form any
           more -- it opens the one dialog, with no position, and dagre places
           the node. */
            onCreateChild={(parent) =>
              child.begin({ parentId: parent.id, parentName: parent.displayName, position: null })
            }
          />

          {confirm.dialog}
        </div>
      </RunControls>
    </RunAvailability.Provider>
  );
}

export function Root(): JSX.Element {
  return (
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  );
}
