import type { DeletionImpactView } from '@bonsai/shared';
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
      `Its files, its history and its branch are untouched. Only the ${impact.branches} ` +
        `branch${impact.branches === 1 ? '' : 'es'} Bonsai created there, and the experiment folders ` +
        'for them, are removed.',
    );
  }
  for (const path of impact.removesDirectories) {
    paragraphs.push(`This folder and its contents are deleted from disk: ${path}`);
  }

  return paragraphs;
}
