import { recoveryCause, type RunView } from '@bonsai/shared';

/**
 * What the recovery notice says, by what actually happened (D45).
 *
 * The old notice called every one of these an interruption and offered
 * "Resume run", which told the agent it had been interrupted -- including
 * after a run that had finished while a process it started kept writing. The
 * cause decides the words here, and the same cause decides the prompt the
 * agent gets (git/recovery.ts), so the two cannot tell different stories.
 */
export interface RecoveryWords {
  headline: string;
  /** Extra facts: the failure's message, background work that was stopped. */
  details: string[];
  /** The line about the files themselves. */
  files: string;
  /** Starts a run from these files. */
  continueLabel: string;
  continueTitle: string;
  /** Clears the notice and leaves the files. Null once already left. */
  leaveLabel: string | null;
  /** Null when there is nothing to discard, or the folder is the user's own. */
  discardLabel: string | null;
}

export function recoveryWords({
  runs,
  interrupted,
  changedFiles,
  isYourFolder,
}: {
  runs: readonly RunView[];
  /** The node is still marked interrupted: nobody has decided about it yet. */
  interrupted: boolean;
  changedFiles: number;
  isYourFolder: boolean;
}): RecoveryWords {
  const last = runs.at(-1);
  const cause = recoveryCause(last);
  const nothing = changedFiles === 0;
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

  const headline = interrupted
    ? {
        stopped: 'You stopped this run.',
        failed: 'The run failed.',
        app_closed: 'Bonsai closed while this run was working.',
        changed_after_finish: 'This run did not finish.',
      }[cause]
    : {
        stopped: 'Work from the run you stopped is still uncommitted.',
        failed: 'Work from the failed run is still uncommitted.',
        app_closed: 'Work from the run cut off when Bonsai closed is still uncommitted.',
        changed_after_finish:
          last === undefined
            ? 'This experiment’s folder has uncommitted changes.'
            : 'Files changed after this run finished.',
      }[cause];

  const details: string[] = [];
  if (cause === 'failed' && last?.error != null && last.error.trim() !== '') {
    details.push(last.error.trim());
  }
  if (last !== undefined && last.stoppedBackground > 0) {
    details.push(
      `${last.stoppedBackground} background ${plural(last.stoppedBackground, 'job was', 'jobs were')} still running and ${plural(last.stoppedBackground, 'was', 'were')} stopped.`,
    );
  }

  const count = `${changedFiles} ${plural(changedFiles, 'file', 'files')}`;
  const files = nothing
    ? isYourFolder
      ? 'Nothing was written — this experiment only reads your folder.'
      : 'Nothing was written, so there is nothing to keep.'
    : cause === 'changed_after_finish'
      ? `${count} changed after the last commit and ${plural(changedFiles, 'is', 'are')} not saved in any result.`
      : `${count} not yet saved in any result.`;

  return {
    headline,
    details,
    files,
    continueLabel: nothing
      ? 'Run it again'
      : cause === 'changed_after_finish'
        ? 'Ask the agent to review them'
        : 'Continue from these files',
    continueTitle: nothing
      ? 'Starts the same request again from the beginning.'
      : cause === 'changed_after_finish'
        ? 'The agent is shown exactly what changed and asked to check and finish it. Then the run commits as usual.'
        : 'The agent is shown exactly what landed and asked to finish the request without redoing it.',
    leaveLabel: interrupted ? (nothing ? 'Dismiss' : 'Leave uncommitted') : null,
    discardLabel: nothing || isYourFolder ? null : 'Discard…',
  };
}
