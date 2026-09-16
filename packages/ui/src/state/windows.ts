import type { ChangeScope } from '@bonsai/shared';

/**
 * Floating diff windows (D44): where each one is, and what can be done to it.
 *
 * Inside the app, over the map. Never a browser tab or an OS window: the owner
 * wants to read several files side by side, as in an editor, without leaving.
 * They belong to one experiment -- switching hides them, coming back restores
 * them -- because comparing experiments side by side is out of scope (B8).
 *
 * Pure functions over a plain value, so every rule about geometry is tested
 * without a browser: new windows cascade and never leave the map, opening an
 * open file brings its window forward instead of a copy, and there are never
 * more than four.
 */
export interface Area {
  width: number;
  height: number;
}

export interface DiffWindow {
  /** The scope and the path together: a file is open at most once per scope. */
  id: string;
  path: string;
  scope: ChangeScope;
  /** "All changes", "Run 3", "Uncommitted". */
  scopeLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stacking order; the highest is in front. */
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** When it was opened, to know which one is oldest. */
  opened: number;
}

export interface Windows {
  list: DiffWindow[];
  /** The highest z handed out so far. */
  top: number;
  /** How many windows have ever been opened here. */
  opened: number;
}

export const NO_WINDOWS: Windows = { list: [], top: 0, opened: 0 };
export const MAX_WINDOWS = 4;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 180;
/** Space kept between windows, and between a window and the map's edge. */
export const GAP = 8;
/** How far each new window steps from the one before it. */
export const CASCADE = 28;

export function windowId(scope: ChangeScope, path: string): string {
  return JSON.stringify([scope.kind, scope.kind === 'run' ? scope.runId : '', path]);
}

/**
 * Opens a file, or brings its window forward if it is already open -- restoring
 * it if minimised. A fifth window replaces the one opened longest ago.
 */
export function openWindow(
  state: Windows,
  target: { path: string; scope: ChangeScope; scopeLabel: string },
  area: Area,
): Windows {
  const id = windowId(target.scope, target.path);
  const existing = state.list.find((w) => w.id === id);
  if (existing !== undefined) {
    return focusWindow(
      { ...state, list: state.list.map((w) => (w.id === id ? { ...w, minimized: false } : w)) },
      id,
    );
  }

  let list = state.list;
  if (list.length >= MAX_WINDOWS) {
    const oldest = list.reduce((a, b) => (b.opened < a.opened ? b : a));
    list = list.filter((w) => w !== oldest);
  }
  const size = defaultSize(area);
  const step = CASCADE * (list.length % 6);
  const top = state.top + 1;
  const opened = state.opened + 1;
  const window: DiffWindow = {
    id,
    ...target,
    ...fit({ x: GAP + step, y: GAP + step, ...size }, area),
    z: top,
    minimized: false,
    maximized: false,
    opened,
  };
  return { list: [...list, window], top, opened };
}

export function focusWindow(state: Windows, id: string): Windows {
  const window = state.list.find((w) => w.id === id);
  if (window === undefined || window.z === state.top) return state;
  const top = state.top + 1;
  return { ...state, top, list: state.list.map((w) => (w.id === id ? { ...w, z: top } : w)) };
}

export function closeWindow(state: Windows, id: string): Windows {
  return { ...state, list: state.list.filter((w) => w.id !== id) };
}

export function closeAll(state: Windows): Windows {
  return { ...state, list: [] };
}

/** Moves a window, keeping all of it on the map. */
export function moveWindow(state: Windows, id: string, x: number, y: number, area: Area): Windows {
  return update(state, id, (w) => ({ ...w, ...fit({ ...w, x, y }, area), maximized: false }));
}

/** Resizes a window from any edge, no smaller than readable and no larger than the map. */
export function resizeWindow(
  state: Windows,
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  area: Area,
): Windows {
  return update(state, id, (w) => ({ ...w, ...fit(rect, area), maximized: false }));
}

export function toggleMinimized(state: Windows, id: string): Windows {
  return update(state, id, (w) => ({ ...w, minimized: !w.minimized }));
}

export function toggleMaximized(state: Windows, id: string): Windows {
  return focusWindow(
    update(state, id, (w) => ({ ...w, maximized: !w.maximized, minimized: false })),
    id,
  );
}

/**
 * Shows another file in a window, for previous / next and Jump to file. If
 * that file already has a window of its own, that one comes forward instead
 * and this one closes, so nothing is ever open twice.
 */
export function showFile(state: Windows, id: string, path: string): Windows {
  const window = state.list.find((w) => w.id === id);
  if (window === undefined) return state;
  const nextId = windowId(window.scope, path);
  if (nextId === id) return state;
  if (state.list.some((w) => w.id === nextId)) return focusWindow(closeWindow(state, id), nextId);
  return focusWindow(
    update(state, id, (w) => ({ ...w, id: nextId, path })),
    nextId,
  );
}

/**
 * Side by side: every window restored and given an equal share of the map.
 * Up to three in a row; four in two rows of two.
 */
export function tileWindows(state: Windows, area: Area): Windows {
  const order = [...state.list].sort((a, b) => a.opened - b.opened);
  const count = order.length;
  if (count === 0) return state;
  const columns = count <= 3 ? count : 2;
  const rows = Math.ceil(count / columns);
  const width = (area.width - GAP * (columns + 1)) / columns;
  const height = (area.height - GAP * (rows + 1)) / rows;
  const placed = new Map(
    order.map((w, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return [
        w.id,
        fit(
          {
            x: Math.round(GAP + column * (width + GAP)),
            y: Math.round(GAP + row * (height + GAP)),
            width: Math.floor(width),
            height: Math.floor(height),
          },
          area,
        ),
      ];
    }),
  );
  return {
    ...state,
    list: state.list.map((w) => ({
      ...w,
      ...placed.get(w.id)!,
      minimized: false,
      maximized: false,
    })),
  };
}

/** Back into a cascade, oldest at the back, each restored to the default size. */
export function stackWindows(state: Windows, area: Area): Windows {
  const order = [...state.list].sort((a, b) => a.opened - b.opened);
  const size = defaultSize(area);
  let top = state.top;
  const placed = new Map(
    order.map((w, index) => {
      top += 1;
      const step = CASCADE * (index % 6);
      return [w.id, { ...fit({ x: GAP + step, y: GAP + step, ...size }, area), z: top }];
    }),
  );
  return {
    ...state,
    top,
    list: state.list.map((w) => ({
      ...w,
      ...placed.get(w.id)!,
      minimized: false,
      maximized: false,
    })),
  };
}

/** After the map changes size: nothing may be left off it. */
export function fitAll(state: Windows, area: Area): Windows {
  let changed = false;
  const list = state.list.map((w) => {
    const fitted = fit(w, area);
    if (
      fitted.x === w.x &&
      fitted.y === w.y &&
      fitted.width === w.width &&
      fitted.height === w.height
    ) {
      return w;
    }
    changed = true;
    return { ...w, ...fitted };
  });
  return changed ? { ...state, list } : state;
}

/**
 * The next or previous window, for the keyboard. In the order they were
 * opened rather than front to back: bringing one forward changes the stacking,
 * and cycling by stacking would only ever swap the front two.
 */
export function cycleWindows(state: Windows, direction: 1 | -1): Windows {
  const visible = state.list.filter((w) => !w.minimized).sort((a, b) => a.opened - b.opened);
  if (visible.length < 2) return state;
  const front = frontWindow({ ...state, list: visible });
  const index = visible.findIndex((w) => w.id === front?.id);
  return focusWindow(state, visible[(index + direction + visible.length) % visible.length]!.id);
}

export function frontWindow(state: Windows): DiffWindow | null {
  return state.list.reduce<DiffWindow | null>((a, b) => (a === null || b.z > a.z ? b : a), null);
}

function update(state: Windows, id: string, change: (w: DiffWindow) => DiffWindow): Windows {
  return { ...state, list: state.list.map((w) => (w.id === id ? change(w) : w)) };
}

function defaultSize(area: Area): { width: number; height: number } {
  return {
    width: Math.min(760, Math.max(MIN_WIDTH, Math.round(area.width * 0.6))),
    height: Math.min(620, Math.max(MIN_HEIGHT, Math.round(area.height * 0.72))),
  };
}

/** A rectangle kept whole on the map: first no larger than it, then inside it. */
export function fit(
  rect: { x: number; y: number; width: number; height: number },
  area: Area,
): { x: number; y: number; width: number; height: number } {
  const width = Math.round(
    Math.min(Math.max(rect.width, Math.min(MIN_WIDTH, area.width)), area.width),
  );
  const height = Math.round(
    Math.min(Math.max(rect.height, Math.min(MIN_HEIGHT, area.height)), area.height),
  );
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(rect.x, 0), Math.max(0, area.width - width))),
    y: Math.round(Math.min(Math.max(rect.y, 0), Math.max(0, area.height - height))),
  };
}
