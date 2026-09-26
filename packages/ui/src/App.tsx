import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { PANEL_WIDTH, type NodeView } from '@bonsai/shared';

import { useConfirm } from './ConfirmDialog.tsx';
import { PanelResizer } from './PanelResizer.tsx';
import { api } from './api/client.ts';
import { describeError } from './api/describeError.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { CanvasNotices } from './canvas/CanvasNotices.tsx';
import { CompareBar } from './canvas/CompareBar.tsx';
import { MenuBar } from './canvas/MenuBar.tsx';
import { NewChildDialog } from './canvas/NewChildDialog.tsx';
import { useCardActions } from './canvas/useCardActions.tsx';
import { ComparePage } from './compare/ComparePage.tsx';
import { ComparisonsDialog } from './compare/ComparisonsDialog.tsx';
import { ConnectionScreen } from './panel/ConnectionScreen.tsx';
import { ConversationRail } from './panel/ConversationRail.tsx';
import { Panel } from './panel/Panel.tsx';
import { SettingsDialog } from './panel/SettingsDialog.tsx';
import { StartScreen } from './panel/StartScreen.tsx';
import { UsageDialog } from './panel/UsageDialog.tsx';
import { ReferencesDialog } from './panel/references/ReferencesDialog.tsx';
import { SnapshotDialog } from './panel/references/SnapshotDialog.tsx';
import { Review } from './review/Review.tsx';
import { RunAvailability } from './state/RunAvailability.ts';
import { RunControls, StopAll } from './state/RunControls.tsx';
import { useComparisons } from './state/compare.ts';
import { ExperimentsContext, useExperimentList, type Experiments } from './state/experiments.ts';
import { ReferencesContext, useReferenceLibrary, type References } from './state/references.ts';
import { useSelection } from './state/selection.ts';
import { readAddress, useAddressBar } from './state/useAddressBar.ts';
import { useChildCreation } from './state/useChildCreation.ts';
import { useComparePicking } from './state/useComparePicking.ts';
import { useConnection } from './state/useConnection.ts';
import { usePanelWidth } from './state/usePanelWidth.ts';
import { useProjectTree } from './state/useProjectTree.ts';
import { useRestoredSelection } from './state/useRestoredSelection.ts';
import { useRunStream } from './state/useRunStream.ts';
import { useTextScale } from './state/useTextScale.ts';
import { useWorkspaceView } from './state/useWorkspaceView.ts';

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
  useTextScale(settings?.textScale);
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
  useRestoredSelection(tree, selection, arrivedAt);
  const selected: NodeView | null = tree?.nodes.find((n) => n.id === selection.primary) ?? null;
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
  const comparing = useComparePicking(projectId, selection.primary, arrivedAt.compareId);
  useAddressBar({ projectId, nodeId: selection.primary, compareId: comparing.comparing });
  const live = useRunStream(projectId, projectTree.refresh);
  const comparisonList = useComparisons(projectId, live.comparisonsRevision);
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
  const library = useReferenceLibrary(projectId, live.referencesRevision, report);
  const experiments = useExperimentList(tree?.nodes, selectExperiment);
  const child = useChildCreation({
    projectId,
    onCreated: selection.select,
    onError: report,
    refresh: projectTree.refresh,
  });

  /**
   * Review is a full-screen replacement for the map, not an overlay: reading a
   * change is the whole job while you are doing it. The map keeps its own
   * viewport underneath, hidden.
   */
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    if (selected === null) setReviewing(false);
  }, [selected]);
  const panelWidth = usePanelWidth(reviewing, view, settings?.panelWidth, setSettings);

  const cards = useCardActions({
    nodes: tree?.nodes,
    refresh: projectTree.refresh,
    report,
    branch: child.begin,
    review: (nodeId) => {
      selectExperiment(nodeId);
      setReviewing(true);
    },
    select: selectExperiment,
    openReference: library.setTarget,
    ask: confirm.ask,
  });

  const [showComparisons, setShowComparisons] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'app' | 'project'>('app');
  const [showUsage, setShowUsage] = useState(false);
  const openSettings = (tab: 'app' | 'project'): void => {
    setSettingsTab(tab);
    setShowSettings(true);
  };
  const settingsChanged = (): void => {
    reload();
    projectTree.refresh();
  };
  /** Set when the user asked for the start screen, and which half of it. */
  const [startMode, setStartMode] = useState<'new' | 'existing' | null>(null);

  if (connection.state === 'unknown' && projects.length === 0)
    return (
      <div className="app single">
        <div className={`connect${connectionError === null ? ' loading' : ''}`} role="status">
          {connectionError ?? 'Checking connection'}
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
    <WindowContexts
      connected={connection.state === 'connected'}
      references={library.references}
      experiments={experiments}
    >
      <RunControls nodes={tree?.nodes ?? []} onChanged={projectTree.refresh}>
        <div
          className={`app${view.experimentOpen ? '' : ' panel-hidden'}${reviewing ? ' review-mode' : ''}${comparing.comparing !== null && tree !== null ? ' compare-mode' : ''}`}
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
              onOpenSettings={() => openSettings('app')}
              onOpenUsage={() => setShowUsage(true)}
              references={tree === null ? null : library.references.list.length}
              onOpenReferences={() => library.setTarget({ kind: 'library' })}
              comparisons={comparisonList.length}
              onOpenComparisons={() => setShowComparisons(true)}
              onDeleteProject={() =>
                void projectTree.deleteCurrent().catch((e: unknown) => report(describeError(e)))
              }
            />
            <CanvasNotices
              agentAvailable={connection.state === 'connected'}
              onReconnectAgent={() => openSettings('app')}
              error={error}
              onDismissError={() => setError(null)}
              connectionError={connectionError}
              onRetryConnection={reload}
              reconnecting={live.health === 'reconnecting'}
              treeError={projectTree.error}
              treeShown={tree !== null}
              treeLoading={projectTree.loading}
              onRetryTree={projectTree.retry}
            />
            <StopAll nodes={tree?.nodes ?? []} />

            <Canvas
              key={projectId}
              nodes={tree?.nodes ?? []}
              selectedId={selection.primary}
              onSelect={selectExperiment}
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
              actions={cards.actions}
              picks={comparing.picks}
              onPick={comparing.pick}
              onPicking={comparing.setPicking}
            />
            {comparing.picks !== null && (
              <CompareBar
                picks={comparing.picks}
                nodes={tree?.nodes ?? []}
                busy={comparing.busy}
                error={comparing.error}
                onCompare={comparing.compare}
                onRemove={comparing.pick}
                onCancel={() => comparing.setPicking(false)}
              />
            )}
          </div>

          {comparing.comparing !== null && tree !== null && (
            <ComparePage
              key={comparing.comparing}
              comparisonId={comparing.comparing}
              projectId={tree.project.id}
              revision={`${live.comparisonsRevision}:${live.revision}`}
              onBack={() => comparing.open(null)}
              onOpenExperiment={(id) => {
                comparing.open(null);
                selectExperiment(id);
              }}
              ask={confirm.ask}
            />
          )}
          {showComparisons && tree !== null && (
            <ComparisonsDialog
              projectName={tree.project.name}
              list={comparisonList}
              onOpen={(id) => {
                setShowComparisons(false);
                comparing.open(id);
              }}
              onClose={() => setShowComparisons(false)}
            />
          )}

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
              redo={child.pending.redo}
              onSelectSource={selection.select}
              onCancel={child.cancel}
              onCreate={child.create}
            />
          )}

          {!view.narrow && !view.experimentOpen && (
            <ConversationRail name={selected?.displayName ?? null} onOpen={view.showExperiment} />
          )}

          <PanelResizer
            width={panelWidth.width}
            min={PANEL_WIDTH.min}
            max={PANEL_WIDTH.max}
            onCommit={panelWidth.commit}
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
            onProjectSettings={() => openSettings('project')}
            onStartFromLatest={(behind) => {
              if (behind.behind === null) return;
              child.begin({
                parentId: behind.behind.parentId,
                parentName: behind.behind.parentName,
                position: null,
                redo: { id: behind.id, name: behind.displayName },
              });
            }}
            onChanged={projectTree.refresh}
            /* The panel does not own a second, weaker version of this form any
           more -- it opens the one dialog, with no position, and dagre places
           the node. */
          />

          {cards.dialogs}
          {library.target !== null &&
            tree !== null &&
            (library.target.kind === 'snapshot' ? (
              <SnapshotDialog
                runId={library.target.runId}
                reference={library.target.reference}
                onOpenCurrent={(id) => library.setTarget({ kind: 'edit', id })}
                onClose={() => library.setTarget(null)}
              />
            ) : (
              <ReferencesDialog
                target={library.target}
                projectId={tree.project.id}
                projectName={tree.project.name}
                nodes={tree.nodes}
                onClose={() => library.setTarget(null)}
              />
            ))}
          {confirm.dialog}
        </div>
      </RunControls>
    </WindowContexts>
  );
}

/**
 * What anything in the window may read: whether runs can start, the project's
 * references, and its experiments.
 */
function WindowContexts({
  connected,
  references,
  experiments,
  children,
}: {
  connected: boolean;
  references: References;
  experiments: Experiments;
  children: ReactNode;
}): JSX.Element {
  return (
    <RunAvailability.Provider value={connected}>
      <ReferencesContext.Provider value={references}>
        <ExperimentsContext.Provider value={experiments}>{children}</ExperimentsContext.Provider>
      </ReferencesContext.Provider>
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
