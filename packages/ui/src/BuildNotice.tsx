import { useEffect, useState, type JSX } from 'react';
import { api } from './api/client.ts';
import { buildChanged, observeBuild } from './api/version.ts';

/** A reload is explicit: drafts survive, and unsaved settings retain their browser warning. */
export function BuildNotice(): JSX.Element | null {
  const [changed, setChanged] = useState(buildChanged);
  useEffect(() => {
    const update = (): void => setChanged(buildChanged());
    const check = (): void => {
      if (!document.hidden)
        void api
          .version()
          .then((value) => observeBuild(value.buildId))
          .catch(() => undefined);
    };
    window.addEventListener('bonsai:updated', update);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 15000);
    update();
    check();
    return () => {
      clearInterval(timer);
      window.removeEventListener('bonsai:updated', update);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return changed ? (
    <div className="build-notice" role="alert">
      Bonsai was updated. Reload this tab before making changes.{' '}
      <button onClick={() => window.location.reload()}>Reload Bonsai</button>
    </div>
  ) : null;
}
