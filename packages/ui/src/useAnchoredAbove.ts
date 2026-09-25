import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Where a popover that opens upward from the panel's floor should sit.
 *
 * The panel's foot scrolls in its exceptional states (a long question, a
 * recovery notice), and a scrolling box clips anything that rises out of it --
 * which is exactly where a menu above the composer has to be. A popover placed
 * with `position: fixed` escapes that clipping, because nothing above it in the
 * panel is transformed, and it stays in the document where it was, so a click
 * inside it is still a click inside its menu.
 *
 * `stretch` spans the anchor's width; `right` lines the popover's right edge
 * up with the anchor's. Measured again on resize and on any scroll, so it
 * follows the anchor rather than the moment it opened.
 */
export function useAnchoredAbove(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  align: 'stretch' | 'right',
  /** Anything that moves the anchor while open, such as text growing a box. */
  moved?: unknown,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!open || element === null) {
      setStyle(null);
      return;
    }
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const bottom = window.innerHeight - rect.top + 6;
      setStyle(
        align === 'stretch'
          ? { left: rect.left, width: rect.width, bottom }
          : { right: window.innerWidth - rect.right, bottom },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, open, align, moved]);
  return style;
}
