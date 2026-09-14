import type { DiagnosticsView } from '@bonsai/shared';

/** Diagnostics exclude free-form names/errors/output. Logs retain only event identity and numeric metrics. */
export function diagnosticReport(
  input: DiagnosticsView,
  knownKeys: readonly string[] = [],
): DiagnosticsView {
  const log = input.log.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      if (typeof entry.t === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.t))
        kept.t = entry.t;
      if (['info', 'warn', 'error'].includes(String(entry.level))) kept.level = entry.level;
      if (typeof entry.event === 'string' && /^[a-z]+(?:\.[a-z_]+)+$/.test(entry.event))
        kept.event = entry.event;
      for (const [key, value] of Object.entries(entry)) {
        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean')
          kept[key] = value;
      }
      return Object.keys(kept).length > 0 ? [JSON.stringify(kept)] : [];
    } catch {
      return [];
    }
  });
  const safe: DiagnosticsView = {
    ...input,
    log,
    connection: { ...input.connection, message: null },
    node:
      input.node === null
        ? null
        : {
            ...input.node,
            displayName: '[omitted]',
            runs: input.node.runs.map((run) => ({ ...run, error: null })),
          },
  };
  // Apply known-key and common credential-pattern redaction to the remaining metadata (including paths).
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const key of knownKeys) if (key.length > 0) text = text.split(key).join('[redacted]');
      return text
        .replace(/\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)]));
    return value;
  };
  return redact(safe) as DiagnosticsView;
}
