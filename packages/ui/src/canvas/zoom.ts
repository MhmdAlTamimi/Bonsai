/**
 * How far the canvas may zoom.
 *
 * Shared because three things need the same two numbers: React Flow's own
 * bounds, the zoom buttons that have to stop at them, and the level-of-detail
 * thresholds in NodeCard that are chosen relative to them. Two copies of a
 * bound is how a button ends up enabled at a zoom it cannot reach.
 */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 1.8;

/**
 * How the whole tree is fitted on screen: when a project opens, and by Fit
 * canvas.
 *
 * One setting for every fit. React Flow fits once by itself, when it has first
 * measured the cards, and with its own defaults that went as far as MAX_ZOOM;
 * Bonsai's fit a moment later brought it back to 1. So the map opened with a
 * visible jump, and a card clicked in between moved out from under the pointer.
 */
export const FIT = { padding: 0.2, maxZoom: 1, duration: 0 } as const;
