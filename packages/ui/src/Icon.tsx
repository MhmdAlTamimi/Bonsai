import type { ComponentProps, JSX, ReactNode } from 'react';
const paths = {
  diff: 'M8 3h7l5 5v13H4V3ZM14 3v6h6M8 13h6M11 10v6M8 18h6',
  file: 'M8 3h7l5 5v13H4V3ZM14 3v6h6M8 13h8M8 17h8',
  wrap: 'M3 6h18M3 11h13a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 16h4',
  folderOpen: 'M3 8V5h6l2 3h9v3M3 8v12h16l3-9H7l-4 9',
  play: 'm8 4 12 8-12 8Z',
  arrowRight: 'M4 12h16m-6-6 6 6-6 6',
  arrowLeft: 'M20 12H4m6-6-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5ZM12 14v3',
  pin: 'm9 3 6 0-1 6 4 4v2H6v-2l4-4ZM12 15v7',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  question: 'M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  warning: 'm12 3 10 18H2ZM12 9v5M12 17h.01',
  circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  finished: 'M5 5h14v14H5ZM9 12h6',
  // Canvas controls. Drawn to the same 24px grid and 1.8 stroke as the rest, so
  // the family reads as one set rather than as icons from three sources.
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  automatic: 'M4 8h16M4 16h16M9 4v4M15 16v4',
  // Navigation and menus. These replaced typographic characters -- x, dots,
  // arrows, carets, a house -- which came from the font rather than from this
  // family and so had their own weight, baseline and size at every place they
  // appeared.
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  home: 'M4 11 12 4l8 7M6 10v9h12v-9',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  reference: 'M6 3h12v18l-6-4-6 4Z',
  // Two columns side by side: experiments read against each other.
  compare: 'M4 4h6v16H4ZM14 4h6v16h-6Z',
  // A branch: one experiment of the tree, wherever it is mentioned outside it.
  experiment:
    'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  // Actions that say themselves: copying, done, and stopping.
  copy: 'M9 9h11v11H9ZM5 15H4V4h11v1',
  check: 'm5 12 5 5 9-10',
  stop: 'M7 7h10v10H7Z',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5',
} as const;
export type IconName = keyof typeof paths;

/** Drawn solid rather than as a line: a stop is a filled square in every player ever made. */
const FILLED: ReadonlySet<IconName> = new Set(['stop']);

export function Icon({ name }: { name: IconName }): JSX.Element {
  const filled = FILLED.has(name);
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

/**
 * A button that is only an icon, and says what it does on hover.
 *
 * One component rather than a class per place, because each place used to
 * grow its own: a ⋯ here at 16px, a × there as a font glyph, a close with an
 * aria-label and no tooltip, a copy with a tooltip and no label. The label is
 * required and is both the accessible name and the tooltip, so an icon can
 * never be left for someone to guess at.
 *
 * `tone="danger"` is for Stop: red without words, the one place colour alone
 * is allowed to carry the action, because the square says it too.
 */
export function IconButton({
  icon,
  label,
  title,
  size = 'md',
  tone,
  className = '',
  children,
  ...rest
}: Omit<ComponentProps<'button'>, 'aria-label' | 'children'> & {
  icon: IconName;
  /** What it does: the accessible name, and the tooltip unless `title` says more. */
  label: string;
  size?: 'md' | 'sm' | 'xs';
  tone?: 'danger' | 'accent';
  /** Words shown beside the icon, for the moment something needs saying (Copied). */
  children?: ReactNode;
}): JSX.Element {
  // The default size has no class of its own: `md` is already the markdown container.
  const classes = [
    'icon-button',
    size === 'md' ? '' : size,
    tone,
    children == null ? '' : 'labelled',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...rest} className={classes} aria-label={label} title={title ?? label}>
      <Icon name={icon} />
      {children}
    </button>
  );
}
