import { OperationConflict } from '../domain/errors.js';
/** Structural Git operations in one project must not remove each other's worktrees. */
export class ProjectOperations {
  private readonly active = new Set<string>();
  async run<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.active.has(id))
      throw new OperationConflict(
        'This project is creating or deleting an experiment. Retry when that finishes.',
      );
    this.active.add(id);
    try {
      return await work();
    } finally {
      this.active.delete(id);
    }
  }
}
