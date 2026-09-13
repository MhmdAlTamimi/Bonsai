import type { DeletionImpactView } from '@bonsai/shared';

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
  const spent = impact.costUsd > 0 ? ` and about $${impact.costUsd.toFixed(2)} of agent runs` : '';
  const paragraphs = [
    `This permanently removes ${impact.nodes} node${impact.nodes === 1 ? '' : 's'}${spent}. ` +
      'It cannot be undone.',
  ];

  if (impact.keepsDirectory !== null) {
    paragraphs.push(
      `Your folder is left alone: ${impact.keepsDirectory}`,
      `Its files, its history and its branch are untouched. Only the ${impact.branches} ` +
        `branch${impact.branches === 1 ? '' : 'es'} Bonsai created there, and the worktrees ` +
        'for them, are removed.',
    );
  } else if (impact.removesDirectory !== null) {
    paragraphs.push(`This folder is deleted from disk: ${impact.removesDirectory}`);
  }

  return paragraphs;
}
