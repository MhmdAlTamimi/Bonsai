/**
 * Counting things in words, one way everywhere: "1 run", "2 runs", "1,204 files".
 *
 * Written inline twenty-odd times before, each with its own `=== 1 ? '' : 's'`
 * and some without the thousands separator the rest had. Shared because the
 * server writes counts too, into what the agent reads.
 */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? word : many}`;
}
