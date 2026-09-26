import type { JSX } from 'react';

import { ErrorNote } from '../ErrorNote.tsx';

/**
 * What the map says about the app itself, over the canvas: the agent being
 * unavailable, an error, the event stream reconnecting, the project failing
 * to load. At most a line each, and each with the one thing that can be done.
 */
export function CanvasNotices({
  agentAvailable,
  onReconnectAgent,
  error,
  onDismissError,
  connectionError,
  onRetryConnection,
  reconnecting,
  treeError,
  treeShown,
  treeLoading,
  onRetryTree,
}: {
  agentAvailable: boolean;
  onReconnectAgent: () => void;
  error: string | null;
  onDismissError: () => void;
  connectionError: string | null;
  onRetryConnection: () => void;
  reconnecting: boolean;
  treeError: string | null;
  /** A tree is on screen, so a failure is about updates rather than the project. */
  treeShown: boolean;
  treeLoading: boolean;
  onRetryTree: () => void;
}): JSX.Element {
  return (
    <>
      {!agentAvailable && (
        <div className="transport-notice" role="status">
          Agent unavailable · Saved experiments are available.{' '}
          <button onClick={onReconnectAgent}>Reconnect agent</button>
        </div>
      )}
      {error !== null && (
        <ErrorNote className="banner" onDismiss={onDismissError}>
          {error}
        </ErrorNote>
      )}
      {connectionError !== null && (
        <ErrorNote className="banner" onRetry={onRetryConnection} retryLabel="Retry connection">
          {connectionError}
        </ErrorNote>
      )}
      {reconnecting && (
        <div className="transport-notice loading" role="status">
          Reconnecting to Bonsai · showing the last received state
        </div>
      )}
      {treeError !== null ? (
        <ErrorNote className="tree-notice" onRetry={onRetryTree} retryLabel="Retry project">
          {treeShown && 'Project updates unavailable. '}
          {treeError}
        </ErrorNote>
      ) : treeLoading && !treeShown ? (
        <div className="tree-notice loading" role="status">
          Loading project
        </div>
      ) : null}
    </>
  );
}
