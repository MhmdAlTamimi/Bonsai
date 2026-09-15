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
