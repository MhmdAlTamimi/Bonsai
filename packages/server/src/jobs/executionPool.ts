import { OperationConflict } from '../domain/errors.js';

export interface PoolJob {
  id: string;
  projectId: string;
  kind: 'run' | 'comparison' | 'draft';
  label: string;
  controller: AbortController;
  state?: () => 'working' | 'question' | 'background';
  resource?: string;
  resourceAvailable?: () => boolean;
}
interface Entry extends PoolJob {
  execute: () => Promise<void>;
  cancelQueued: () => void;
  onAbort: () => void;
}

/** One FIFO bound for every model process, including the work it leaves running. */
export class ExecutionPool {
  private readonly active = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly retiring = new Set<string>();
  private paused = false;
  private mutations = 0;
  private readonly resources = new Set<string>();
  constructor(
    private readonly limit: () => number,
    private readonly changed: (projects: ReadonlySet<string>) => void = () => undefined,
  ) {}

  assertAvailable(projectId?: string): void {
    if (this.paused)
      throw new OperationConflict('Bonsai is making a backup. Retry when it finishes.');
    if (projectId !== undefined && this.retiring.has(projectId))
      throw new OperationConflict(
        'This project is stopping its jobs for removal or relocation. Retry after it finishes.',
      );
  }
  enqueue(job: PoolJob, execute: () => Promise<void>, cancelQueued: () => void): void {
    this.assertAvailable(job.projectId);
    if (this.active.has(job.id) || this.queue.some((entry) => entry.id === job.id))
      throw new OperationConflict('This job is already scheduled.');
    const entry: Entry = {
      ...job,
      execute,
      cancelQueued,
      onAbort: () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.controller.signal.removeEventListener('abort', entry.onAbort);
        entry.cancelQueued();
        this.notify();
        this.pump();
      },
    };
    if (job.controller.signal.aborted) {
      cancelQueued();
      return;
    }
    this.queue.push(entry);
    job.controller.signal.addEventListener('abort', entry.onAbort, { once: true });
    this.pump();
    this.notify();
  }
  async run<T>(job: PoolJob, execute: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) =>
      this.enqueue(
        job,
        async () => {
          try {
            resolve(await execute());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        () => reject(new OperationConflict('The queued job was cancelled.')),
      ),
    );
  }
  position(id: string): number | null {
    const index = this.queue.findIndex((entry) => entry.id === id);
    return index < 0 ? null : index + 1;
  }
  reason(id?: string): string {
    const waiting = this.queue.find((job) => job.id === id);
    if (waiting?.resource) {
      const owner = [...this.active.values()].find((job) => job.resource === waiting.resource);
      if (owner)
        return `Waiting for ${owner.label} to release this project’s workspace${owner.state?.() === 'question' ? ' — answer its question or stop it' : ''}.`;
      if (waiting.resourceAvailable?.() === false)
        return 'Release “Keep active” to switch this project’s workspace.';
      if (this.resources.has(waiting.resource))
        return 'Waiting for this project’s workspace operation to finish.';
    }
    const live = [...this.active.values()];
    const questions = live.filter((job) => job.state?.() === 'question').length;
    const background = live.filter((job) => job.state?.() === 'background').length;
    const other = live.filter((job) => job.kind !== 'run').length;
    return (
      `Waiting for ${live.length} active ${live.length === 1 ? 'job' : 'jobs'} to finish` +
      (questions ? `; ${questions} ${questions === 1 ? 'needs' : 'need'} your answer` : '') +
      (background ? `; ${background} ${background === 1 ? 'has' : 'have'} background work` : '') +
      (other ? `; ${other} ${other === 1 ? 'is' : 'are'} a comparison or reference draft` : '') +
      '. Stop a job or answer its question to free a slot.'
    );
  }
  jobs(): PoolJob[] {
    return [...this.active.values(), ...this.queue];
  }
  resourceOwner(resource: string): PoolJob | undefined {
    return [...this.active.values()].find((job) => job.resource === resource);
  }
  resourceBusy(resource: string): boolean {
    return this.resources.has(resource) || this.resourceOwner(resource) !== undefined;
  }
  async drain(timeoutMs = 3000): Promise<void> {
    for (const job of this.jobs()) job.controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.jobs().length > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  refresh(): void {
    this.pump();
    this.notify();
  }
  private notify(): void {
    this.changed(new Set(this.jobs().map((job) => job.projectId)));
  }
  private pump(): void {
    while (!this.paused && this.active.size < Math.max(1, this.limit())) {
      const index = this.queue.findIndex(
        (entry) =>
          !this.retiring.has(entry.projectId) &&
          (!entry.resource ||
            (!this.resources.has(entry.resource) &&
              ![...this.active.values()].some((active) => active.resource === entry.resource))) &&
          entry.resourceAvailable?.() !== false,
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      entry.controller.signal.removeEventListener('abort', entry.onAbort);
      this.active.set(entry.id, entry);
      let execution: Promise<void>;
      try {
        execution = entry.execute();
      } catch (error) {
        execution = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // Unexpected finalization failures still reach the app's fatal-error handler.
      void execution.finally(() => {
        this.active.delete(entry.id);
        this.pump();
        this.notify();
      });
    }
  }
  async withStoppedProject<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    this.assertAvailable(projectId);
    this.retiring.add(projectId);
    try {
      for (const job of this.jobs()) if (job.projectId === projectId) job.controller.abort();
      const deadline = Date.now() + 10000;
      while (this.jobs().some((job) => job.projectId === projectId)) {
        if (Date.now() >= deadline)
          throw new OperationConflict(
            'Project jobs are still stopping. Files are preserved; retry after they finish.',
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return await work();
    } finally {
      this.retiring.delete(projectId);
      this.notify();
    }
  }
  /** HTTP mutations and idle filesystem operations cannot overlap a consistent backup. */
  async mutation<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    this.mutations += 1;
    try {
      return await work();
    } finally {
      this.mutations -= 1;
    }
  }
  /** Idle filesystem operations share the same exclusion boundary as scheduled runs. */
  async withResource<T>(resource: string | undefined, work: () => Promise<T>): Promise<T> {
    if (!resource) return this.mutation(work);
    if (
      this.resources.has(resource) ||
      [...this.active.values()].some((job) => job.resource === resource)
    )
      throw new OperationConflict(
        'This project’s workspace is busy. Retry after its current operation finishes.',
      );
    this.resources.add(resource);
    try {
      return await this.mutation(work);
    } finally {
      this.resources.delete(resource);
      this.pump();
      this.notify();
    }
  }
  async exclusivelyWhenIdle<T>(work: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.jobs().length > 0 || this.mutations > 0 || this.retiring.size > 0)
      throw new OperationConflict(
        'Bonsai must be idle to make a consistent backup. Finish or stop active jobs, then retry.',
      );
    this.paused = true;
    try {
      return await work();
    } finally {
      this.paused = false;
      this.pump();
      this.notify();
    }
  }
}
