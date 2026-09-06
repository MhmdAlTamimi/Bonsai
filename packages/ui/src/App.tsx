import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type NodeMouseHandler,
  ReactFlowProvider,
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

  const { nodes, edges } = useMemo(
    () => (tree === null ? { nodes: [], edges: [] } : layoutTree(tree.nodes)),
    [tree],
  );

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
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  const nodeCount = nodes.length;
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

  const onNodeDragStop: NodeMouseHandler = (_event, node) => {
    void api
      .updateNode(node.id, { positionX: node.position.x, positionY: node.position.y })
      .catch((e: unknown) => setError(String(e)));
  };

  const flowNodes = nodes.map((n) => ({ ...n, selected: selection.ids.includes(n.id) }));

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
        {error !== null && <div className="banner">{error}</div>}
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={selection.clear}
          minZoom={0.2}
          maxZoom={1.8}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
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
