import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '@bonsai/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly milestone?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A route that exists in the contract but whose milestone has not landed. */
export function notYet(milestone: string, what: string): never {
  throw new HttpError(501, `${what} lands in ${milestone}`, milestone);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    const body: ApiError = { error: err.message };
    if (err.milestone !== undefined) body.milestone = err.milestone;
    sendJson(res, err.status, body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[bonsai] unhandled: ${message}\n`);
  sendJson(res, 500, { error: message } satisfies ApiError);
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new HttpError(413, 'request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'malformed JSON body');
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}
