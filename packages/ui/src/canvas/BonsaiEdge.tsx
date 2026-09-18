import type { JSX } from 'react';
import type { EdgeProps } from 'reactflow';

/**
 * The line from a parent to a child (D46).
 *
 * An elbow with rounded corners rather than a curve: the tree is ranked, and
 * a right-angled turn at the midpoint says "this one came from that one"
 * without wandering across the map. It leaves the parent's `+` — which is
 * where a child comes from — and enters the child's top edge.
 *
 * The path through the selected experiment's ancestors is solid and accented;
 * every other branch is dashed, so the line you are working along is legible
 * in a tree of fifty.
 */
export function BonsaiEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<{ live?: boolean; conversationOnly?: boolean }>): JSX.Element {
  const classes = [
    'bonsai-edge',
    data?.live === true ? 'live' : '',
    data?.conversationOnly === true ? 'conversation' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <path id={id} className={classes} d={elbowPath(sourceX, sourceY, targetX, targetY)} />;
}

/** Down, across at the midpoint, down again — with 10px corners. */
export function elbowPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  corner = 10,
): string {
  // A child directly under its parent gets a straight line; a corner radius
  // would only wobble it.
  if (Math.abs(sourceX - targetX) < 1) return `M ${sourceX},${sourceY} L ${targetX},${targetY}`;

  const midY = (sourceY + targetY) / 2;
  const direction = targetX > sourceX ? 1 : -1;
  const radius = Math.max(
    0,
    Math.min(corner, Math.abs(targetX - sourceX) / 2, Math.abs(targetY - sourceY) / 2),
  );
  return [
    `M ${sourceX},${sourceY}`,
    `L ${sourceX},${midY - radius}`,
    `Q ${sourceX},${midY} ${sourceX + direction * radius},${midY}`,
    `L ${targetX - direction * radius},${midY}`,
    `Q ${targetX},${midY} ${targetX},${midY + radius}`,
    `L ${targetX},${targetY}`,
  ].join(' ');
}
