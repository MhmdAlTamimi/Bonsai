import type { DeletionImpactView, NodeDeletionImpactView } from '@bonsai/shared';
import { plural } from '../words.ts';

/**
 * What to say before deleting a project.
 *
 * A pure function, and separate from the flow that shows it, because the whole
 * value of this text is that it is accurate: it promises "your folder is left
 * alone" to someone about to press a button that cannot be undone. Being able
 * to read it without reading a dialog flow around it is the point.
 *
 * Paragraphs rather than one string, because the confirmation is a real dialog
 * now rather than `window.confirm`, and the adopted-project case has three
 * separate things to say. The numbers come from the server (see
 * projectDeletionImpact) rather than being inferred here. What deletion destroys differs completely between a
 * project Bonsai built and a folder of the user's it was pointed at, and a
 * promise about that is only worth making if the code that decides it is the
 * code that says it.
 */
export function deletionMessage(impact: DeletionImpactView): string[] {
  const paragraphs = [
    `This permanently removes ${plural(impact.nodes, 'experiment')}, their conversations and run history. ` +
      'It cannot be undone.',
  ];

  if (impact.keepsDirectory !== null) {
    paragraphs.push(
      `Your folder is left alone: ${impact.keepsDirectory}`,
      `Its files, its history and its branch are untouched. Only the ` +
        `${plural(impact.branches, 'branch', 'branches')} Bonsai created there, and the experiment ` +
        'folders for them, are removed.',
    );
  }
  for (const path of impact.removesDirectories) {
    paragraphs.push(`This folder and its contents are deleted from disk: ${path}`);
  }

  return paragraphs;
}

/**
 * What to say before deleting an experiment and everything branched from it.
 *
 * Comparisons that include any of them are named. They are not blocked on:
 * a comparison depends on its experiments, never the other way round, and it
 * already holds its own copy of each one -- conversation, changes, notes and
 * files -- so it stays readable and marks the experiment as deleted. Refusing
 * would only send people to delete comparisons first, losing more.
 */
export function experimentDeletionMessage(impact: NodeDeletionImpactView): string[] {
  const others = impact.nodes - 1;
  const paragraphs = [
    `This permanently removes ${plural(impact.nodes, 'experiment')}, their conversations and run ` +
      'history, saved code, and their experiment folders on disk, including uncommitted files.',
  ];
  if (others > 0) paragraphs.push(`Affected experiments: ${impact.names.join(', ')}`);
  const count = impact.comparisons.length;
  if (count > 0) {
    const titles = impact.comparisons.map((c) => `“${c.title}”`).join(', ');
    const deleted = others > 0 ? 'them' : 'it';
    paragraphs.push(
      count === 1
        ? `Included in the comparison ${titles}. It keeps its own copy and will show ${deleted} ` +
            'as deleted. Delete it from Comparisons if you no longer need it.'
        : `Included in ${count} comparisons: ${titles}. They keep their own copies and will show ` +
            `${deleted} as deleted. Delete them from Comparisons if you no longer need them.`,
    );
  }
  paragraphs.push(
    'Other experiments and the project’s main folder are kept. This cannot be undone.',
  );
  return paragraphs;
}
