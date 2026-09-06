import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, { Background, Controls, type NodeMouseHandler, ReactFlowProvider } from 'reactflow';
import 'reactflow/dist/style.css';
import type { NodeView, TreeResponse } from '@bonsai/shared';

import { api, subscribe } from './api/client.ts';
import { useSelection } from './state/selection.ts';
import { layoutTree } from './canvas/layout.ts';
import { NodeCard } from './canvas/NodeCard.tsx';
import { Panel } from './panel/Panel.tsx';

const nodeTypes = { bonsai: NodeCard };

export function App(): JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          setError('No projects. Project creation lands in M2.');
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
      if (event.type === 'tree.updated' || event.type === 'node.status') void refresh(projectId);
    });
  }, [projectId, refresh]);

  const { nodes, edges } = useMemo(
    () => (tree === null ? { nodes: [], edges: [] } : layoutTree(tree.nodes)),
    [tree],
  );

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
