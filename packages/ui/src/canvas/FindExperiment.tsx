import { useEffect, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';
import { IconButton } from '../Icon.tsx';
import { Dialog, DialogHeader } from '../Dialog.tsx';
import { STATUS_LABEL } from '../nodeStatus.tsx';

export function FindExperiment({
  nodes,
  onSelect,
}: {
  nodes: readonly NodeView[];
  onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.isComposing)
        return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setQuery('');
      setOpen(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const matches = nodes.filter((node) =>
    `${node.displayName} ${node.summaryLine}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const choose = (id: string): void => {
    setOpen(false);
    onSelect(id);
  };
  return (
    <>
      <IconButton
        icon="search"
        label="Find experiment"
        className="canvas-tool icon-only"
        title="Find experiment (⌘K / Ctrl+K)"
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
      />
      {open && (
        <Dialog title="Find experiment" onClose={() => setOpen(false)}>
          <DialogHeader title="Find experiment" onClose={() => setOpen(false)} />
          <input
            data-dialog-focus
            aria-label="Search experiments"
            placeholder="Name or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches[0]) {
                event.preventDefault();
                choose(matches[0].id);
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>('.experiment-matches button')
                  ?.focus();
              }
            }}
          />
          <div className="experiment-matches" aria-label="Matching experiments">
            {matches.slice(0, 100).map((node) => (
              <button key={node.id} onClick={() => choose(node.id)}>
                <span>{node.displayName}</span>
                <small>{STATUS_LABEL[node.status]}</small>
              </button>
            ))}
            {matches.length === 0 && <p>No matching experiments.</p>}
            {matches.length > 100 && (
              <p>Showing 100 of {matches.length} matches. Refine your search.</p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
