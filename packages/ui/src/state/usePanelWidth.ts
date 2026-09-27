import { useEffect, useRef, useState } from 'react';
import { PANEL_WIDTH, REVIEW_WIDTH, type SettingsView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import type { WorkspaceView } from './useWorkspaceView.ts';

/**
 * How wide the conversation is, and whether it is open at all, is a property
 * of WHAT YOU ARE DOING.
 *
 * On the canvas the graph has width to spare and the thread is the point, so
 * the panel is open at its saved width. In review the diff is why you came,
 * so it starts collapsed to the rail and opens to three quarters of that
 * width — and each mode remembers what you last did to it, so review does not
 * keep re-collapsing something you deliberately opened.
 */
export function usePanelWidth(
  reviewing: boolean,
  view: WorkspaceView,
  savedWidth: number | undefined,
  onSaved: (settings: SettingsView) => void,
): { width: number; commit: (width: number) => void } {
  const mode: 'canvas' | 'review' = reviewing ? 'review' : 'canvas';
  const [reviewWidth, setReviewWidth] = useState(REVIEW_WIDTH);
  const canvasWidth = savedWidth ?? PANEL_WIDTH.default;
  const openByMode = useRef<Record<'canvas' | 'review', boolean>>({ canvas: true, review: false });
  const lastMode = useRef(mode);
  const { experimentOpen, narrow, showExperiment, showMap } = view;
  useEffect(() => {
    if (lastMode.current === mode) return;
    openByMode.current[lastMode.current] = experimentOpen;
    lastMode.current = mode;
    // Narrow windows show one thing at a time; the mode's default would fight
    // the Map/Experiment switch the user is steering with.
    if (narrow) return;
    if (openByMode.current[mode]) showExperiment();
    else showMap();
  }, [mode, experimentOpen, narrow, showExperiment, showMap]);

  return {
    width: reviewing ? reviewWidth : canvasWidth,
    commit: (width) => {
      // A width dragged in review belongs to review, and only for this
      // session: the saved width is the one the canvas reads.
      if (reviewing) {
        setReviewWidth(width);
        return;
      }
      // Fire and forget: the width is already applied to the CSS variable,
      // so a failed save costs this session nothing and the next one a
      // default. Not worth a banner.
      void api
        .updateSettings({ panelWidth: width })
        .then(onSaved)
        .catch(() => undefined);
    },
  };
}
