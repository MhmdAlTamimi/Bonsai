# Audit phase 12 — Review and Apply

2026-10-03, `main` at 5842b8c. Reading an experiment's changes on the
review screen, and taking them to your own repository with Apply. Apply was
tested end to end — the command it shows, run as written — and Review was
timed on a larger repository. Some of Apply's dialog was written earlier in
this session; it was tested as strictly as the rest.

Files: `api/review.ts`, `git/review.ts`, `git/snapshot.ts`,
`api/applyPatch.ts`, `review/Review.tsx`, `review/DiffPane.tsx`,
`review/ReviewTree.tsx`, `review/ReviewMenu.tsx`,
`panel/node/ApplyDialog.tsx`.

## How it works

**Review** lists every file the experiment changed — committed and
uncommitted together, with a status letter and counts — and loads one file's
diff at a time (cut at 2 MiB, and saying so). *Only this experiment* is its
own step; *Whole line* is everything since its line left master. Paths are
checked against the list before git sees them, and file contents are read
from git objects, never through a symlink in the folder.

**Apply** writes the committed change of the chosen scope, without Bonsai's
notes, as a patch file in Bonsai's data folder (`--binary --full-index`), and
shows one command: `git -C <your folder> apply --3way <patch>` for a project
made from your folder, or `git apply --3way <patch>` "in the repository you
want the changes in" for one Bonsai created. It warns when your folder is on
a different branch, and offers the patch as a download for Git apps.

## Findings

### V1 · High · verified — For a project Bonsai created, there is no safe way to take an experiment's code out

A project Bonsai created exists only inside Bonsai's data folder. To use an
experiment's result elsewhere, you have:

- **Apply**, whose patch is the line's change *on top of master* — master's
  own code, which is also only inside Bonsai, is not in it. Applied to a new
  repository it gives the experiment's new files without the code they
  build on.
- **Review's *Open experiment folder*.** The obvious next step is to copy
  that folder. It is a git worktree: its `.git` is a one-line file pointing
  into Bonsai's internal repository. `copied-folder.mjs` copied it and
  committed in the copy — the commit landed in Bonsai's repository and moved
  the experiment itself; its next run in Bonsai stopped with "Git state
  changed outside Bonsai", the dead end of phase 5's R1. The copy and the
  experiment share one position and one index from then on.

"Use this code outside Bonsai", which once offered a checkout command, is
gone. For a project made from your folder none of this applies: the code is
already in your repository and Apply is exact (below).

Reproduce: `node scripts/audit/copied-folder.mjs`.

**Fix (S–M).**

- **Save code to a folder…** on an experiment: `git archive` of its commit,
  without Bonsai's notes, unpacked into a folder you choose (or a zip). No
  `.git`, no link back, nothing to break.
- **New repository from this experiment…**: a `git clone` of Bonsai's
  repository into a folder you choose, on a branch at the experiment's
  commit — independent history you can push.
- In the Apply dialog for a created project, say that the patch is relative
  to master's code and point to the two above.

### V2 · Medium · verified — Review is twenty times slower when the experiment has uncommitted work

While a run is going, after Stop, or after *Leave uncommitted*, the folder
holds work not yet committed, and Review includes it — by building a
snapshot of the folder from a fresh index (`snapshot.ts`), which hashes every
file in the repository again. It does that for the file list, and again for
each file you open (once to find the file in the list, once for its patch).
`review-cost.mjs`, a folder of 40,000 files:

| | Everything committed | One file uncommitted |
| --- | --- | --- |
| Open Review (the file list) | 81 ms | 1,292 ms |
| Open a file | 117 ms | 2,616 ms |
| Open another | — | 2,595 ms |

Reviewing a run while it works — the card's *Review +N* stays live — means
two and a half seconds per click.

Reproduce: `node scripts/audit/review-cost.mjs`.

**Fix (S).** Start the snapshot from a copy of the folder's real index, as
phase 3 (P6) measured — 80 ms instead of 1.3 s on the same repository — and
take it once per request, passing it to both the list and the patch.

### V3 · Low · verified — What Apply's command prints is hard to read, on success and on failure

Run in a terminal, the command answers in git's words:

- a clean apply prints lines such as "Falling back to direct
  application…", which read like something went wrong;
- a conflict prints "Applied patch to 'src/app.js' with conflicts." among
  the same lines, exits 1, and leaves *every other file applied and staged*;
- an uncommitted edit of yours in a file the change touches prints "Applied
  patch to 'logo.png' cleanly" and then "error: src/app.js: does not match
  index" — and nothing at all was applied.

`--quiet` is not the answer: it silences the conflict message too (tested).
The dialog says what git does, but not what its output looks like.

**Fix (S).** In the dialog, three lines on reading the result — "Falling back
to direct application" is normal; "with conflicts" means both versions are in
the file to choose between; "does not match index" means nothing was applied
because of your own unsaved edits. Optionally, a *Check my folder* button
that runs `git status` there afterwards and says which of the three happened.

## What is solid

- **Apply is exact.** `apply-roundtrip.mjs` gave an experiment every awkward
  kind of change — an edited file, a replaced binary image, a rename, a
  deletion, a script made non-executable, a file whose name has spaces,
  accents and a dash, and an empty file. The command as shown reproduced the
  experiment's files in your folder exactly, byte for byte.
- **Apply never overwrites your work.** Your own change to the same line
  leaves conflict markers to choose between; your own unsaved edit stops the
  whole patch.
- **The command works where it is pasted**: it names your folder, so it
  works from any terminal, with paths quoted for each platform; *Whole line*
  by default, *Only this experiment* when its parents are already applied; a
  warning when your folder is on another branch.
- **Review is built to be safe and fast**: one file at a time, a 2 MiB cap
  per file that says so, paths checked against the list, contents read from
  git rather than the folder, and archived experiments still reviewable.

## Worth considering

A very large diff is drawn whole: a generated 30,000-line file took 1.3 s to
show and put 120,000 elements on the page. The 2 MiB cap bounds it; drawing
only the visible lines would make even that instant.

## Fix first

V1 — the code of a project Bonsai created has no way out that is both whole
and safe, and the natural workaround damages the experiment. Then V2, a small
change with a large effect, then V3's wording.
