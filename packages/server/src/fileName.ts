/** Portable names without discarding the user's language or creating device names. */
export function fileName(name: string, fallback: string, maxBytes = 120): string {
  const clean = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  let result = '';
  for (const char of clean) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) break;
    result += char;
  }
  result = result.replace(/-+$/g, '') || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result) ? `_${result}` : result;
}
