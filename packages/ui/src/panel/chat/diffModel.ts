/**
 * A unified patch, turned into something renderable.
 *
 * The diff is the product of an experiment -- the artefact you opened the node
 * to evaluate -- and it used to render as one undifferentiated `<pre>`: no
 * colour, no per-file grouping, no counts. That is strictly worse than
 * `git diff` in a terminal, which at least colours the lines.
 *
 * Parsing only, no JSX, so it is testable under Node's type stripping without a
 * browser (see diffModel.test.ts). Diff.tsx renders the result.
 *
 * This reads git's own output and nothing else. It does not know a repository
 * exists, cannot ask for one, and is handed a string the server produced --
 * PRD §9 constraint 5 holds: the interface still has nothing git-shaped in it
 * beyond text it was given.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading +/-/space marker. */
  text: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  /** True for a file git reports as binary, which has no lines to show. */
  binary: boolean;
  lines: DiffLine[];
}

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Split a patch into files.
 *
 * Tolerant on purpose: a patch that does not start with `diff --git` (a plain
 * `diff -u`, or output already trimmed by something upstream) still yields one
 * file rather than nothing, because showing an unlabelled diff beats showing an
 * empty panel and claiming there were no changes.
 */
export function parsePatch(patch: string): DiffFile[] {
  const text = patch.replace(/\r\n?/g, '\n');
  if (text.trim() === '') return [];

  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  const open = (path: string): DiffFile => {
    const file: DiffFile = { path, added: 0, removed: 0, binary: false, lines: [] };
    files.push(file);
    return file;
  };

  for (const line of text.split('\n')) {
    const header = GIT_HEADER.exec(line);
    if (header !== null) {
      // Prefer the b/ side: for a rename it is where the file ended up, which
      // is the name the user is looking for.
      current = open(header[2] ?? header[1]!);
      continue;
    }

    current ??= open('(unnamed)');

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }

    // `---`/`+++` are headers, not content, and must be counted as neither.
    // Checked before the +/- branches below, which is the whole reason they
    // are listed first: `+++ b/x` starts with `+`.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      current.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      current.added += 1;
      current.lines.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      current.removed += 1;
      current.lines.push({ kind: 'del', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" -- git's own note, not part of either side.
      current.lines.push({ kind: 'meta', text: line });
      continue;
    }
    // A trailing empty string from the final newline is not a context line.
    if (line === '') continue;
    current.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
  }

  return files;
}

/** Totals across every file, for the one-line summary above the diff. */
export function patchTotals(files: readonly DiffFile[]): {
  files: number;
  added: number;
  removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/**
 * Whether a file should start open.
 *
 * A node's whole diff can be thousands of lines, and rendering all of it
 * expanded is both unreadable and slow. Small files open; large ones and any
 * file past the first few collapse to a header the user can click. The
 * thresholds are deliberately generous -- most single-node experiments are
 * small, and collapsing a 20-line change would be officious.
 */
export function shouldExpand(file: DiffFile, index: number): boolean {
  if (file.binary) return false;
  return index < 4 && file.lines.length <= 120;
}
