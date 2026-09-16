import type { AgentQuestion } from '@bonsai/shared';

/**
 * What the user has picked for one question the agent asked, and what that
 * amounts to as an answer.
 *
 * Kept out of the component because the rules are where the mistakes would be:
 * an "Other" answer that is typed but not selected, a single-choice question
 * holding two answers, a blank sent for a question nobody got to.
 */
export interface Picked {
  /** Chosen option labels, in the order the agent offered them. */
  selected: string[];
  /** Whether "Other" is chosen. The tool promises the agent it is always offered. */
  other: boolean;
  otherText: string;
  /** The option last chosen, whose preview is shown. */
  focus: string | null;
}

export const NOTHING_PICKED: Picked = { selected: [], other: false, otherText: '', focus: null };

/** Choosing an option. A single-choice question holds exactly one answer. */
export function pickOption(question: AgentQuestion, picked: Picked, label: string): Picked {
  if (!question.multiSelect)
    return { selected: [label], other: false, otherText: picked.otherText, focus: label };
  const on = !picked.selected.includes(label);
  const labels = on ? [...picked.selected, label] : picked.selected.filter((l) => l !== label);
  return {
    ...picked,
    // Offered order, not click order: the answer should read the way the
    // question was asked, whatever order the boxes were ticked in.
    selected: question.options.map((o) => o.label).filter((l) => labels.includes(l)),
    focus: on ? label : picked.focus === label ? null : picked.focus,
  };
}

/** Turning "Other" on or off. On a single-choice question it replaces the option. */
export function pickOther(question: AgentQuestion, picked: Picked, on: boolean): Picked {
  return question.multiSelect
    ? { ...picked, other: on }
    : {
        ...picked,
        other: on,
        selected: on ? [] : picked.selected,
        focus: on ? null : picked.focus,
      };
}

/** Typing an answer of your own chooses "Other" -- nobody types there by accident. */
export function typeOther(question: AgentQuestion, picked: Picked, text: string): Picked {
  return { ...pickOther(question, picked, true), otherText: text };
}

/**
 * The answer string, or '' when this question is not answered yet.
 *
 * A multi-select answer is its parts joined with ", ", which is the form the
 * SDK hands the agent. An "Other" that is chosen but empty is not an answer.
 */
export function answerFor(question: AgentQuestion, picked: Picked): string {
  const own = picked.other ? picked.otherText.trim() : '';
  if (!question.multiSelect) return own !== '' ? own : (picked.selected[0] ?? '');
  return [...picked.selected, ...(own === '' ? [] : [own])].join(', ');
}

/** Every question's answer, or null while any question is unanswered. */
export function allAnswers(
  questions: readonly AgentQuestion[],
  picks: readonly Picked[],
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [i, question] of questions.entries()) {
    const answer = answerFor(question, picks[i] ?? NOTHING_PICKED);
    if (answer === '') return null;
    out[question.question] = answer;
  }
  return out;
}
