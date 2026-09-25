import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { NodeView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Icon, IconButton } from '../Icon.tsx';

export const hasActiveJob = (node: NodeView): boolean =>
  node.status === 'running' || node.status === 'needs_you';
const Context = createContext<{
  stopping: ReadonlySet<string>;
  errors: Record<string, string>;
  stop: (id: string) => void;
} | null>(null);

/** Shared across cards and the panel. An accepted stop is pending until server state confirms it. */
export function RunControls({
  nodes,
  onChanged,
  children,
}: {
  nodes: readonly NodeView[];
  onChanged: () => void;
  children: ReactNode;
}): JSX.Element {
  const pending = useRef(new Map<string, string | null | undefined>());
  const questions = useRef(new Map<string, string | undefined>());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const changedQuestions = new Set(
      nodes
        .filter((node) => questions.current.get(node.id) !== node.pendingQuestion?.id)
        .map((node) => node.id),
    );
    questions.current = new Map(nodes.map((node) => [node.id, node.pendingQuestion?.id]));
    for (const [id, runId] of pending.current) {
      const node = nodes.find((n) => n.id === id);
      if (!node || !hasActiveJob(node) || node.activeRunId !== runId) pending.current.delete(id);
    }
    setStopping(new Set(pending.current.keys()));
    setErrors((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(
          ([id]) => !changedQuestions.has(id) && nodes.some((n) => n.id === id && hasActiveJob(n)),
        ),
      ),
    );
  }, [nodes]);
  useEffect(() => {
    if (stopping.size === 0) return;
    const timer = setInterval(onChanged, 1500);
    return () => clearInterval(timer);
  }, [stopping, onChanged]);
  const stop = (id: string): void => {
    if (pending.current.has(id)) return;
    pending.current.set(id, nodes.find((node) => node.id === id)?.activeRunId);
    setStopping(new Set(pending.current.keys()));
    setErrors((prev) => ({ ...prev, [id]: '' }));
    void api
      .cancelNode(id)
      .then(onChanged)
      .catch((e: unknown) => {
        pending.current.delete(id);
        setStopping(new Set(pending.current.keys()));
        setErrors((prev) => ({ ...prev, [id]: describeError(e) }));
      });
  };
  return <Context.Provider value={{ stopping, errors, stop }}>{children}</Context.Provider>;
}

/**
 * Stopping, for a surface that is not a button of its own.
 *
 * The card carries no standing Stop any more -- the design leaves it the name,
 * the state and the way into review -- so its ⋯ menu offers the same action,
 * and it is the same pending-until-confirmed stop the panel uses.
 */
export function useStopRun(node: NodeView): { stop: () => void; busy: boolean } | null {
  const controls = useContext(Context);
  if (controls === null || !hasActiveJob(node)) return null;
  return { stop: () => controls.stop(node.id), busy: controls.stopping.has(node.id) };
}

export function StopButton({ node }: { node: NodeView }): JSX.Element | null {
  const controls = useContext(Context);
  if (!controls || !hasActiveJob(node)) return null;
  const busy = controls.stopping.has(node.id);
  return (
    <span className="stop-control">
      <IconButton
        icon="stop"
        tone="danger"
        className="stop nodrag"
        label={`Stop ${node.displayName}`}
        title={busy ? 'Stopping' : 'Stop this run'}
        aria-busy={busy}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          controls.stop(node.id);
        }}
      />
      {controls.errors[node.id] && (
        <span className="error stop-error" role="alert">
          {controls.errors[node.id]}
        </span>
      )}
    </span>
  );
}

export function StopAll({ nodes }: { nodes: readonly NodeView[] }): JSX.Element | null {
  const controls = useContext(Context);
  const active = nodes.filter(hasActiveJob);
  if (!controls || active.length < 2) return null;
  const busy = active.some((n) => controls.stopping.has(n.id));
  return (
    <button
      className="stop stop-all"
      disabled={busy}
      title={active
        .map(
          (n) =>
            `${n.displayName}: ${n.queuePosition !== null ? 'queued' : n.status === 'needs_you' ? 'waiting for permission' : 'running'}`,
        )
        .join('\n')}
      aria-busy={busy}
      onClick={() => active.forEach((n) => controls.stop(n.id))}
    >
      <Icon name="stop" /> Stop all {active.length} runs
    </button>
  );
}
