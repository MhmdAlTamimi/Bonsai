import type { RunView } from './contract.js';

/**
 * Why an experiment's folder holds work nobody committed (D45).
 *
 * Every one of these used to be called an interruption, including a run that
 * finished normally while a process it started kept writing -- and "Resume
 * run" then told the agent it had been interrupted, which it believed, so it
 * stopped. The cause decides the words, for the user and for the agent.
 */
export type RecoveryCause = 'stopped' | 'failed' | 'app_closed' | 'changed_after_finish';

/**
 * The cause, from the last run. Shared so the notice the user reads and the
 * prompt the agent receives cannot disagree about what happened.
 *
 * A run that finished -- or no run at all -- can only have left uncommitted
 * files by something changing them afterwards.
 */
export function recoveryCause(lastRun: Pick<RunView, 'endReason'> | undefined): RecoveryCause {
  const reason = lastRun?.endReason;
  return reason === 'stopped' || reason === 'failed' || reason === 'app_closed'
    ? reason
    : 'changed_after_finish';
}
