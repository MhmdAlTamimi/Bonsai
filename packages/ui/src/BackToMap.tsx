import type { JSX } from 'react';

import { Icon } from './Icon.tsx';

/**
 * The way back from a screen that replaced the map -- Review, Compare. One
 * control, so both say "map" (the word the rest of the app uses) and both
 * show the key that does the same thing.
 */
export function BackToMap({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button className="back" onClick={onBack} title="Back to the map (Esc)">
      <Icon name="arrowLeft" />
      <span className="back-label">Map</span>
      <span className="keycap" aria-hidden="true">
        Esc
      </span>
    </button>
  );
}
