/** Defense in depth for diagnostic metadata; callers must still omit prompts and output. */
export function redactCredentials(value: unknown, knownKeys: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const key of knownKeys) if (key.length > 0) text = text.split(key).join('[redacted]');
    return text
      .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.map((item) => redactCredentials(item, knownKeys));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        /^(?:authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/i.test(
          key,
        )
          ? '[redacted]'
          : redactCredentials(field, knownKeys),
      ]),
    );
  return value;
}
