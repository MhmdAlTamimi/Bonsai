import { type RefObject, useLayoutEffect } from 'react';

/**
 * A text box that grows with what is typed, to `maxLines`, and then scrolls
 * inside itself -- the one place allowed its own scroll, because the button
 * that sends must never be pushed out of the window by the draft.
 *
 * Measured from the box's own line height and padding, so it follows the text
 * size preference without knowing about it.
 */
export function useAutosize(
  box: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxLines: number,
  /** Anything else that changes the box's size: it being shown, say. */
  extra?: unknown,
): void {
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const style = getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.round(line * maxLines + padding))}px`;
  }, [box, value, maxLines, extra]);
}
