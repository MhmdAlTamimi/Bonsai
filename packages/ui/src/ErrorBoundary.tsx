import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

/**
 * The last line of defence between a render-time bug and a white screen.
 *
 * Without one, any exception thrown while rendering unmounts the whole tree and
 * leaves an empty page: no message, no stack, no way back short of a manual
 * reload. That is a bad failure mode anywhere and a worse one here, where a
 * run may be in flight and costing money behind the blank page.
 *
 * A class, because React has no hook equivalent -- `componentDidCatch` and
 * `getDerivedStateFromError` are only available on class components. This is
 * the one place in the interface that has to be one.
 *
 * It deliberately does NOT try to recover in place. React gives no guarantee
 * about the state of a tree that threw mid-render, so the honest options are
 * "show what broke" and "start over", and both are offered.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console keeps the component stack, which the panel below cannot show
    // without turning into a debugger.
    console.error('Bonsai crashed while rendering:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash">
        <h1>Bonsai hit a bug and stopped drawing.</h1>
        <p className="muted">
          Nothing on the server was affected: your projects, nodes and any run in flight are
          untouched, and reloading picks them back up.
        </p>
        <pre className="stream">{error.stack ?? `${error.name}: ${error.message}`}</pre>
        <div className="row">
          <button onClick={() => window.location.reload()}>Reload</button>
          <button className="linkish" onClick={() => this.setState({ error: null })}>
            Try to carry on
          </button>
        </div>
        <p className="hint">
          “Try to carry on” re-renders from the same state that just failed, so it usually only
          helps if the cause has since gone away. Reload is the reliable one.
        </p>
      </div>
    );
  }
}
