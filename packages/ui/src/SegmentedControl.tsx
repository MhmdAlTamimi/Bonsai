import { useCallback, useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';

/** One selection fill, sized to the actual buttons (including unequal labels). */
export function SegmentedControl({
  selectedIndex,
  label,
  className = '',
  as: Element = 'div',
  children,
}: {
  selectedIndex: number;
  label: string;
  className?: string;
  as?: 'div' | 'nav';
  children: ReactNode;
}): JSX.Element {
  const root = useRef<HTMLElement | null>(null);
  const selected = useRef(selectedIndex);
  const previous = useRef(selectedIndex);
  const attach = useCallback((element: HTMLElement | null) => {
    root.current = element;
  }, []);
  const measure = useCallback((animate = false) => {
    const group = root.current;
    const button = group?.querySelectorAll<HTMLButtonElement>(':scope > button')[selected.current];
    if (!group || !button) return;
    const bounds = button.getBoundingClientRect();
    if (bounds.width === 0) {
      group.dataset.ready = 'false';
      return;
    }
    const left = bounds.left - group.getBoundingClientRect().left - group.clientLeft;
    const right = group.clientWidth - left - bounds.width;
    const leftValue = `${left}px`;
    const rightValue = `${right}px`;
    if (
      group.dataset.ready === 'true' &&
      group.style.getPropertyValue('--fill-left') === leftValue &&
      group.style.getPropertyValue('--fill-right') === rightValue
    )
      return;
    group.dataset.animate = String(animate && group.dataset.ready === 'true');
    group.style.setProperty('--fill-left', leftValue);
    group.style.setProperty('--fill-right', rightValue);
    group.dataset.ready = 'true';
  }, []);

  useLayoutEffect(() => {
    selected.current = selectedIndex;
    if (root.current) {
      root.current.dataset.direction = selectedIndex > previous.current ? 'right' : 'left';
    }
    measure(selectedIndex !== previous.current);
    previous.current = selectedIndex;
  }, [selectedIndex, measure]);

  useLayoutEffect(() => {
    const group = root.current;
    if (!group) return;
    // Resize and font changes snap to the layout; only a user's selection animates.
    const observer = new ResizeObserver(() => measure());
    observer.observe(group);
    group.querySelectorAll(':scope > button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [measure]);

  return (
    <Element
      ref={attach}
      className={`liquid-switch ${className}`}
      role={Element === 'div' ? 'group' : undefined}
      aria-label={label}
    >
      {children}
    </Element>
  );
}
