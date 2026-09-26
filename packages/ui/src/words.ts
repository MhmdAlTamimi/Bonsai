/** Counting things in words; one definition, shared with the server. */
export { plural } from '@bonsai/shared';

/** A size on disk, in the unit that keeps it short: "840 KB", "1.2 GB". */
export function bytes(count: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0
    ? `${count.toLocaleString()} ${units[0]}`
    : `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
