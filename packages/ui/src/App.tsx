import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type NodeMouseHandler,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { NodeView, TreeResponse } from '@bonsai/shared';

import { api, subscribe } from './api/client.ts';
import { useSelection } from './state/selection.ts';
import { layoutTree } from './canvas/layout.ts';
import { NodeCard } from './canvas/NodeCard.tsx';
import { Panel } from './panel/Panel.tsx';
import { NewProject } from './panel/NewProject.tsx';
import { NewChildDialog } from './canvas/NewChildDialog.tsx';
import { ProjectSettings } from './panel/ProjectSettings.tsx';

const nodeTypes = { bonsai: NodeCard };

export function App(): JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noProjects, setNoProjects] = useState(false);
  // Live run output, keyed by node. Cleared when a run starts so a second run
  // does not read as a continuation of the first.
  const [streams, setStreams] = useState<Record<string, string[]>>({});
  const selection = useSelection();
  /** Set while the new-child dialog is open, after a drag into empty canvas. */
  const [pendingChild, setPendingChild] = useState<{
    parentId: string;
    parentName: string;
    position: { x: number; y: number };
  } | null>(null);
  const dragSource = useRef<string | null>(null);

  /**
   * PRD §9 constraint 3: the backend is the source of truth for the tree. Every
   * mutation refetches; nothing here edits a local tree and hopes the server
   * agrees.
   */
  const refresh = useCallback(async (id: string): Promise<void> => {
    try {
      setTree(await api.tree(id));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void api
      .listProjects()
      .then((ps) => {
        const first = ps[0];
        if (first === undefined) {
          setNoProjects(true);
          return;
        }
        setProjectId(first.id);
        return refresh(first.id);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (projectId === null) return;
    return subscribe(projectId, (event) => {
      switch (event.type) {
        case 'run.started':
          setStreams((prev) => ({ ...prev, [event.nodeId]: [] }));
          break;
        case 'run.delta':
          setStreams((prev) => ({ ...prev, [event.nodeId]: [...(prev[event.nodeId] ?? []), event.text] }));
          break;
        case 'run.error':
          setStreams((prev) => ({ ...prev, [event.nodeId]: [...(prev[event.nodeId] ?? []), event.error] }));
          void refresh(projectId);
          break;
        case 'tree.updated':
        case 'node.status':
        case 'run.finished':
          void refresh(projectId);
          break;
        default:
          break;
      }
    });
  }, [projectId, refresh]);

  /**
   * Rebuild the laid-out nodes, CARRYING OVER what React Flow measured.
   *
   * This is the fix for the canvas going blank after a refresh — reported for
   * changing the model, for chatting, and earlier for creating a node, because
   * all three end in a refetch.
   *
   * React Flow hides a node whose dimensions it has not measured yet
   * (`visibility: hidden`). Handing it a brand-new object on every refresh
   * threw those measurements away, so every node was hidden until it had been
   * re-measured. Locally that is a few milliseconds and invisible; with more
   * nodes or a slower machine the canvas simply looks empty, and zooming --
   * which forces a re-measure -- brings it back. That "zoom in and out to fix
   * it" is the tell.
   *
   * So width/height/positionAbsolute are carried forward per node id, and only
   * the things that actually changed (data, position) are replaced.
   */
  /**
   * React Flow owns the node array; we merge server state into it.
   *
   * This is the fix for the canvas going blank after a refresh — reported for
   * changing the model, for chatting, and earlier for creating a node, because
   * all three end in a refetch.
   *
   * React Flow hides a node it has not measured (`visibility: hidden`) and
   * reports the measurement back through onNodesChange. That handler was never
   * wired, so the measurements had nowhere to land: every refetch replaced the
   * array with freshly-built nodes that looked unmeasured, and every node was
   * hidden until re-measured. Locally that is milliseconds; with more nodes or
   * a slower machine the canvas just looks empty until a zoom forces a
   * re-measure. "Zoom in and out to get it back" was the tell.
   *
   * useNodesState keeps the applyNodeChanges plumbing, so dimensions persist,
   * and merging by id below preserves them across refetches.
   */
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState([]);

  const edges = useMemo(() => (tree === null ? [] : layoutTree(tree.nodes).edges), [tree]);

  useEffect(() => {
    if (tree === null) {
      setFlowNodes([]);
      return;
    }
    const laid = layoutTree(tree.nodes);
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return laid.nodes.map((fresh) => {
        const previous = byId.get(fresh.id);
        // Keep the measured node and overlay only what the server changed.
        return previous === undefined
          ? fresh
          : { ...previous, data: fresh.data, position: fresh.position };
      });
    });
  }, [tree, setFlowNodes]);

  // Refit when the tree gains or loses a node. The layout grows downward, so
  // without this a newly created node lands off-screen -- and having just
  // created one, seeing it is what you want. Keyed on the count rather than the
  // tree so panning and dragging are left alone.
  //
  // Gated on nodesInitialized, not a timer: React Flow has to measure the new
  // card before its bounds are known, and fitting early fits to a partial set.
  // maxZoom caps the other half of that failure -- fitting one small node would
  // otherwise zoom to the limit and fill the screen with a single card.

  /**
   * Refit when the tree grows. Not cosmetic: the layout extends downward, so
   * without this a newly created node lands outside the viewport and cannot be
   * reached at all until you hit the fit control by hand.
   *
   * Two loops to avoid if you touch this. useReactFlow() returns a fresh
   * `fitView` identity whenever the viewport changes, so depending on it makes
   * every fit schedule the next one -- hence the ref. And gating on
   * useNodesInitialized() loops too: fitting changes the zoom, the zoom changes
   * each card's level of detail, that changes the card's size, and React Flow
   * re-measures. A plain timer avoids both.
   *
   * maxZoom stops a single small node from being blown up to fill the screen.
   */
  const { fitView, screenToFlowPosition } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  const screenToFlowRef = useRef(screenToFlowPosition);
  screenToFlowRef.current = screenToFlowPosition;
  const nodeCount = flowNodes.length;
  useEffect(() => {
    if (nodeCount === 0) return;
    const timer = setTimeout(
      () => fitViewRef.current({ duration: 250, padding: 0.2, maxZoom: 1 }),
      120,
    );
    return () => clearTimeout(timer);
  }, [nodeCount]);

  const selected: NodeView | null =
    tree?.nodes.find((n) => n.id === selection.primary) ?? null;

  const onNodeClick: NodeMouseHandler = (event, node) => {
    // Multi-select is wired now even though V0 reads only the first element.
    if (event.metaKey || event.ctrlKey) selection.toggle(node.id);
    else selection.select(node.id);
  };

  /**
   * Dragging out of a node's handle and releasing on empty canvas creates a
   * child there. React Flow has no "connect to nowhere" event, so the source is
   * recorded on connect start and the drop is inspected on connect end: a
   * release over the pane (rather than over another node's handle) is the
   * gesture. Releasing onto a node does nothing -- D1 keeps this a tree, so
   * there is no second parent to connect to.
   */
  const onConnectStart = (_event: unknown, params: { nodeId: string | null }): void => {
    dragSource.current = params.nodeId;
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent): void => {
    const parentId = dragSource.current;
    dragSource.current = null;
    if (parentId === null || tree === null) return;

    const target = event.target as HTMLElement | null;
    if (target === null || !target.classList.contains('react-flow__pane')) return;

    const point = 'clientX' in event ? event : event.changedTouches[0];
    if (point === undefined) return;

    const parent = tree.nodes.find((n) => n.id === parentId);
    setPendingChild({
      parentId,
      parentName: parent?.displayName ?? 'this node',
      position: screenToFlowRef.current({ x: point.clientX, y: point.clientY }),
    });
  };

  const createPendingChild = async (name: string, description: string): Promise<void> => {
    if (pendingChild === null || projectId === null) return;
    try {
      const { node } = await api.createNode(projectId, {
        parentId: pendingChild.parentId,
        displayName: name,
        description,
      });
      // Pin it where it was dropped, so the gesture places the node.
      await api.updateNode(node.id, {
        positionX: pendingChild.position.x,
        positionY: pendingChild.position.y,
      });
      await api.startRun(node.id, description || name);
      setPendingChild(null);
      selection.select(node.id);
      await refresh(projectId);
    } catch (e) {
      setError(String(e));
      setPendingChild(null);
    }
  };

  const onNodeDragStop: NodeMouseHandler = (_event, node) => {
    void api
      .updateNode(node.id, { positionX: node.position.x, positionY: node.position.y })
      .catch((e: unknown) => setError(String(e)));
  };

  if (noProjects) {
    return (
      <div className="app single">
        <NewProject
          onCreated={(id) => {
            setNoProjects(false);
            setProjectId(id);
            void refresh(id);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="canvas">
        {tree !== null && (
          <ProjectSettings
            project={tree.project}
            onChanged={() => {
              if (projectId !== null) void refresh(projectId);
            }}
          />
        )}
        {error !== null && <div className="banner">{error}</div>}
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          // Deliberately NOT clearing the selection on a pane click. The panel
          // is the primary workspace (§7), and emptying it because a click
          // landed between two cards loses your place for no gain -- selecting
          // another node replaces it anyway.
          minZoom={0.25}
          maxZoom={1.8}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {pendingChild !== null && (
        <NewChildDialog
          parentName={pendingChild.parentName}
          onCancel={() => setPendingChild(null)}
          onCreate={createPendingChild}
        />
      )}

      <Panel
        node={selected}
        stream={selected === null ? [] : (streams[selected.id] ?? [])}
        onChanged={() => {
          if (projectId !== null) void refresh(projectId);
        }}
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
