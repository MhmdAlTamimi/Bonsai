import { useMemo, type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { PANEL_WIDTH, type NodeView } from '@bonsai/shared';

import { RunAvailability } from './state/RunAvailability.ts';
import { api } from './api/client.ts';
import { describeError } from './api/describeError.ts';
import { useSelection } from './state/selection.ts';
import { useConnection } from './state/useConnection.ts';
import { useProjectTree } from './state/useProjectTree.ts';
import { useRunStream } from './state/useRunStream.ts';
import { ConversationRail } from './panel/ConversationRail.tsx';
import { Review } from './review/Review.tsx';
import { RenameDialog } from './panel/node/RenameDialog.tsx';
import { ExperimentDetails } from './panel/node/DetailsDialog.tsx';
import { useNodeActions } from './panel/node/useNodeActions.ts';
import { readAddress, useAddressBar } from './state/useAddressBar.ts';
import { useChildCreation } from './state/useChildCreation.ts';
import { useWorkspaceView } from './state/useWorkspaceView.ts';
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
  /**
   * Map and Experiment, and which of them a window this wide can show.
   *
   * Both stay mounted whichever is on screen: switching must not cost the
   * canvas viewport, a reading position or a half-typed draft, and keeping them
   * mounted is the only way to guarantee that rather than re-derive it.
   */
  const view = useWorkspaceView();
  const selectExperiment = (id: string): void => {
    selection.select(id);
    view.selected();
  };
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--text-scale',
      String((settings?.textScale ?? 100) / 100),
    );
  }, [settings?.textScale]);
  useAddressBar({ projectId, nodeId: selection.primary });
  /**
   * ⌘\ (Ctrl+\) collapses the conversation and brings it back — the one
   * shortcut in the workspace, because the panel is the thing you hide to
   * look at the map and want back a second later.
   */
  const toggleConversation = view.toggleExperiment;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggleConversation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleConversation]);
  const live = useRunStream(projectId, projectTree.refresh);
  /**
   * Re-read the credential when a run reports a failure, and not otherwise.
   *
   * The gate records authentication and rate failures as runs report them, so
   * the app has to look again after one. It used to look again after EVERY
   * event -- each status change, each finished run -- which fetched the
   * connection and the whole settings object several times a second on a busy
   * tree and replaced both objects on arrival, re-rendering everything that
   * reads them for no new information.
   */
  useEffect(() => {
    if (live.agentRevision === 0) return;
    reload();
  }, [live.agentRevision, reload]);
  const child = useChildCreation({
    projectId,
    onCreated: selection.select,
    onError: report,
    refresh: projectTree.refresh,
  });

  /**
   * The experiment actions a card's ⋯ offers. They live here because the cards
   * are drawn by the canvas and the dialogs they open belong to the window,
   * not to any one card.
   */
  const [renaming, setRenaming] = useState<NodeView | null>(null);
  const [detailing, setDetailing] = useState<NodeView | null>(null);
  const nodeActions = useNodeActions(projectTree.refresh, (message) => {
    if (message !== null) report(message);
  });
  const cardActions = useMemo(
    () => ({
      branch: (nodeId: string) => {
        const node = tree?.nodes.find((n) => n.id === nodeId);
        if (node !== undefined)
          child.begin({ parentId: node.id, parentName: node.displayName, position: null });
      },
      review: (nodeId: string) => {
        selectExperiment(nodeId);
        setReviewing(true);
      },
      rename: setRenaming,
      details: setDetailing,
      remove: (node: NodeView) => void nodeActions.remove(node),
    }),
    // `child.begin` and the tree change identity on every refetch; the actions
    // only need to be rebuilt when the tree does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, nodeActions.remove],
  );

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

  /**
   * Review is a full-screen replacement for the map, not an overlay: reading a
   * change is the whole job while you are doing it. The map keeps its own
   * viewport underneath, hidden.
   */
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    if (selected === null) setReviewing(false);
  }, [selected]);

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
        <div
          className={`app${view.experimentOpen ? '' : ' panel-hidden'}${reviewing ? ' review-mode' : ''}`}
        >
          {/*
           * Two controls, not one dressed as two.
           *
           * NARROW: the views are alternatives, so this is a segmented switch
           * with exactly one of them current. Experiment is unavailable, and
           * says why, when nothing is selected -- a full-width panel reading
           * "select an experiment" is worse than the map it replaced.
           *
           * WIDE: they are side by side, so there is nothing to switch, and a
           * collapsed conversation keeps its own rail (see ConversationRail)
           * rather than a floating button over the map.
           */}
          <nav className="view-switch" aria-label="Workspace view">
            {view.narrow && (
              <>
                <button
                  className="segment"
                  aria-pressed={!view.experimentOpen}
                  onClick={view.showMap}
                >
                  Map
                </button>
                <button
                  className="segment"
                  aria-pressed={view.experimentOpen}
                  disabled={selected === null}
                  title={selected === null ? 'Choose an experiment on the map first.' : undefined}
                  onClick={view.showExperiment}
                >
                  Experiment
                </button>
              </>
            )}
          </nav>
          {reviewing && selected !== null && (
            <Review
              node={selected}
              revision={`${selected.status}:${selected.lastRunEndReason}:${JSON.stringify(selected.diffStat)}`}
              onBack={() => setReviewing(false)}
            />
          )}
          <div className="canvas" hidden={reviewing}>
            <MenuBar
              project={tree?.project ?? null}
              projects={projects}
              settings={settings}
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
              key={projectId}
              nodes={tree?.nodes ?? []}
              selectedId={selection.primary}
              onSelect={selectExperiment}
              onToggleSelect={selection.toggle}
              onMoved={(nodeId, position) => {
                void api
                  .updateNode(nodeId, { positionX: position.x, positionY: position.y })
                  .catch((e: unknown) => report(describeError(e)));
              }}
              onAutomatic={(nodeId) => {
                void api
                  .updateNode(nodeId, { positionX: null, positionY: null })
                  .then(projectTree.refresh)
                  .catch((e: unknown) => report(describeError(e)));
              }}
              onBranch={child.begin}
              actions={cardActions}
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
              onSelect={selectExperiment}
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

          {!view.narrow && !view.experimentOpen && (
            <ConversationRail name={selected?.displayName ?? null} onOpen={view.showExperiment} />
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
            liveActivity={selected === null ? null : (live.activity[selected.id] ?? null)}
            streamRevision={live.revision}
            visible={view.experimentOpen}
            narrow={view.narrow}
            onHide={view.showMap}
            onProjectSettings={openProjectSettings}
            onChanged={projectTree.refresh}
            /* The panel does not own a second, weaker version of this form any
           more -- it opens the one dialog, with no position, and dagre places
           the node. */
          />

          {renaming !== null && (
            <RenameDialog
              node={renaming}
              onClose={() => setRenaming(null)}
              onChanged={projectTree.refresh}
            />
          )}
          {detailing !== null && (
            <ExperimentDetails node={detailing} onClose={() => setDetailing(null)} />
          )}
          {nodeActions.confirmDialog}
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
