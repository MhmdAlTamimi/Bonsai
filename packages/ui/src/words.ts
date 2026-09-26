/**
 * Counting things in words, one way everywhere: "1 run", "2 runs", "1,204 files".
 *
 * Written inline twenty-odd times before, each with its own `=== 1 ? '' : 's'`
 * and some without the thousands separator the rest had.
 */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? word : many}`;
}

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
