import { type JSX, useId, useState } from 'react';
import type { ChildPreviewView } from '@bonsai/shared';
import { IconButton } from '../Icon.tsx';

/** Read-only source facts, available to mouse, keyboard and touch users. */
export function CreationSourceInfo({
  preview,
  startFresh,
}: {
  preview: ChildPreviewView | null;
  startFresh: boolean;
}): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  return (
    <span
      className="creation-source-info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!pinned && !event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => {
        setOpen(false);
        setPinned(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setPinned(false);
        }
      }}
    >
      <IconButton
        icon="info"
        size="sm"
        label="Source details"
        title=""
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => {
          setPinned(!pinned);
          setOpen(!pinned);
        }}
      />
      <span id={id} role="tooltip" className="creation-source-popover" hidden={!open}>
        {preview === null ? (
          <span>Source details unavailable</span>
        ) : (
          <>
            <span className="creation-source-fact">
              <span>Code from</span>
              <strong>{preview.lineage.codeFrom?.displayName ?? 'Unavailable'}</strong>
            </span>
            <span className="creation-source-fact">
              <span>Conversation from</span>
              <strong>
                {startFresh
                  ? 'None · starts fresh'
                  : (preview.lineage.conversationFrom?.displayName ?? 'None yet')}
              </strong>
            </span>
          </>
        )}
      </span>
    </span>
  );
}
