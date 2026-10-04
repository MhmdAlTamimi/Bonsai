import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ServerEvent } from '@bonsai/shared';

/**
 * D14d: runs are async jobs from day one -- start returns a job id, progress
 * streams, cancellation exists. This is the streaming half.
 *
 * SSE rather than a websocket: every server->client message here is one-way
 * progress. Clients reconcile persisted state after reconnect; events are not replayed. The one
 * client->server message (answering a needs_you question) is a normal POST.
 */
export class EventBus {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private lastId = 0;
  private published = 0;
  private readonly instance = randomUUID();
  private readonly revisions = new Map<string, number>();

  revision(projectId: string): string {
    return `${this.instance}:${projectId === '*' ? this.published : (this.revisions.get(projectId) ?? 0)}`;
  }

  subscribe(projectId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    let set = this.subscribers.get(projectId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(projectId, set);
    }
    set.add(res);

    this.send(res, { type: 'hello', projectId });

    // Comment frames keep intermediaries from closing an idle stream.
    const keepAlive = setInterval(() => {
      if (!res.destroyed && res.writableLength < 1_048_576) res.write(': ping\n\n');
      else res.destroy();
    }, 25_000);
    keepAlive.unref();

    const unsubscribe = (): void => {
      clearInterval(keepAlive);
      const subscribers = this.subscribers.get(projectId);
      subscribers?.delete(res);
      if (subscribers?.size === 0) this.subscribers.delete(projectId);
    };
    res.on('close', unsubscribe);
    return unsubscribe;
  }

  publish(projectId: string, event: ServerEvent): void {
    this.published += 1;
    this.revisions.set(projectId, this.published);
    this.lastId += 1;
    const set = this.subscribers.get(projectId);
    if (set) for (const res of set) this.send(res, event);
    for (const res of this.subscribers.get('*') ?? [])
      this.write(res, 'event', { projectId, event });
  }

  private send(res: ServerResponse, event: ServerEvent): void {
    this.write(res, event.type, event);
  }

  private write(res: ServerResponse, type: string, data: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1_048_576) {
      res.destroy();
      return;
    }
    this.lastId += 1;
    res.write(`id: ${this.lastId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  closeAll(): void {
    for (const set of this.subscribers.values()) {
      for (const res of set) res.end();
    }
    this.subscribers.clear();
  }
}
