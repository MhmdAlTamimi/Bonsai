import { type JSX, useCallback, useEffect, useState } from 'react';
import type { DirectoryListingView } from '@bonsai/shared';
import { api } from '../api/client.ts';

/**
 * A folder picker, served by the backend.
 *
 * The obvious implementation -- `<input type="file" webkitdirectory>` -- cannot
 * work here. A browser hands JavaScript the *names* of the files inside a
 * chosen folder and deliberately withholds where that folder is, so there is no
 * path to send. Since Bonsai's server is the thing that has to open the
 * directory, the server is also the thing that has to list it.
 *
 * Typing a path stays available and is often faster; the list exists for when
 * you would rather look than remember.
 */
export function DirectoryPicker({
  value,
  onChange,
  markRepos = false,
}: {
  value: string;
  onChange: (path: string) => void;
  /** Show which folders are already git repositories. Useful when adopting. */
  markRepos?: boolean;
}): JSX.Element {
  const [listing, setListing] = useState<DirectoryListingView | null>(null);
  const [loading, setLoading] = useState(false);
  // What is in the text box, which is not the same as the chosen path: it is
  // being typed, and half a path should not send the list somewhere else.
  const [typed, setTyped] = useState(value);

  const load = useCallback(async (path?: string): Promise<void> => {
    setLoading(true);
    try {
      const next = await api.browse(path);
      setListing(next);
      setTyped(next.path);
      onChange(next.path);
    } finally {
      setLoading(false);
    }
    // onChange is called on every navigation on purpose: browsing to a folder
    // *is* choosing it, and requiring a second click to confirm the folder you
    // are looking at is the kind of step people miss.
  }, [onChange]);

  useEffect(() => {
    void load(value === '' ? undefined : value).catch(() => {
      /* an unreadable path just leaves the list where it was */
    });
    // Deliberately once: afterwards the picker drives itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="picker">
      <div className="picker-bar">
        <button
          type="button"
          title="Up one level"
          disabled={listing?.parent == null}
          onClick={() => listing?.parent != null && void load(listing.parent)}
        >
          ↑
        </button>
        <input
          value={typed}
          spellCheck={false}
          aria-label="folder path"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void load(typed);
            }
          }}
          onBlur={() => onChange(typed)}
        />
        <button type="button" onClick={() => void load(typed)}>
          Go
        </button>
        {listing !== null && (
          <button type="button" title="Home" onClick={() => void load(listing.home)}>
            ⌂
          </button>
        )}
      </div>

      <div className="picker-list">
        {loading && listing === null ? (
          <p className="muted">Loading…</p>
        ) : listing === null || listing.entries.length === 0 ? (
          <p className="muted">No sub-folders here.</p>
        ) : (
          listing.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className="picker-entry"
              onDoubleClick={() => void load(entry.path)}
              onClick={() => void load(entry.path)}
            >
              <span className="picker-name">{entry.name}</span>
              {markRepos && entry.isGitRepo && <span className="pill tiny">git</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
