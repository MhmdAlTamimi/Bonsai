/**
 * How long ago, in words.
 *
 * The transcript had no timestamps at all, which is survivable in a chat you
 * are watching and useless in this product: runs go in parallel over minutes or
 * hours, so "is this reply from just now or from yesterday" is a real question
 * about a node you have come back to.
 *
 * Coarse on purpose. The exact instant is in the `title` attribute; the label
 * only has to answer "recent, or not".
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((now - then) / 1000);
  // A clock that is slightly behind the server should read "just now", not a
  // negative duration.
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** The full instant, for the tooltip behind the relative label. */
export function exactTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
