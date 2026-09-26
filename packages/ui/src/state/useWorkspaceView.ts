import { useCallback, useEffect, useState } from 'react';

/**
 * Below this, the canvas and the panel cannot both be useful at once.
 *
 * Shared with the stylesheet, which draws the same line. One number in two
 * places is a bug waiting to happen, so the media query below is the source and
 * the CSS comment points here.
 */
export const NARROW_MAX = 900;

export interface WorkspaceView {
  narrow: boolean;
  /** True when the experiment workspace is on screen. */
  experimentOpen: boolean;
  showMap: () => void;
  showExperiment: () => void;
  /** ⌘\: hide the conversation, or bring it back. */
  toggleExperiment: () => void;
  /**
   * Called when the user picks an experiment. On a narrow window that IS the
   * request to look at it; on a wide one the panel is already there, and a
   * collapsed panel stays collapsed until it is asked back.
   */
  selected: () => void;
}

/**
 * Which of the two workspace views is showing, and whether the window can hold
 * both.
 *
 * The two are one hook because the answer to "is the experiment showing"
 * depends on the width: on a wide window the map and the experiment sit side by
 * side and the question is whether the panel is collapsed; on a narrow one they
 * are alternatives and the question is which one you are looking at.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is unmount either side. Switching views
 * must not lose the canvas viewport, the reading position or a half-typed
 * draft, and the cheapest way to guarantee that is for both to stay mounted
 * with one of them hidden. `experimentVisible` is passed down so the parts that
 * cannot survive losing their layout box -- a scroll position, above all --
 * know to restore themselves when they come back.
 */
export function useWorkspaceView(): WorkspaceView {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= NARROW_MAX,
  );
  const [experimentOpen, setExperimentOpen] = useState(true);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_MAX}px)`);
    const apply = (): void => setNarrow(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  /**
   * Growing back to a wide window reopens the panel.
   *
   * Without this, someone who switched to Map at 700px and then widened the
   * window would find half the screen empty with no obvious way back -- the
   * narrow switch is gone by then, because at that width it is not a switch any
   * more.
   */
  useEffect(() => {
    if (!narrow) setExperimentOpen(true);
  }, [narrow]);

  const toggleExperiment = useCallback(() => setExperimentOpen((open) => !open), []);
  /**
   * ⌘\ (Ctrl+\) collapses the conversation and brings it back — the one
   * shortcut in the workspace, because the panel is the thing you hide to
   * look at the map and want back a second later.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggleExperiment();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleExperiment]);

  return {
    narrow,
    experimentOpen,
    showMap: useCallback(() => setExperimentOpen(false), []),
    showExperiment: useCallback(() => setExperimentOpen(true), []),
    toggleExperiment,
    selected: useCallback(() => {
      // On a narrow window nothing else would change on screen, so choosing an
      // experiment and looking at it are the same gesture.
      if (window.innerWidth <= NARROW_MAX) setExperimentOpen(true);
    }, []),
  };
}
