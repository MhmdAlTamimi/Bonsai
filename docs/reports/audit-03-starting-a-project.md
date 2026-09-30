# Audit phase 3 — starting a project

2026-09-30, `main` at 5842b8c. The start page, the folder picker, creating a
project, adopting a folder, choosing the version to start from, unsaved
changes, and "Already in Bonsai". Also, per the plan: shallow clones, detached
checkouts, and a folder that moves after adoption.

Files: `projects.ts` (`createProject`, `adoptProject`, `previewNewDirectory`),
`git/adopt.ts`, `git/snapshot.ts`, `git/repo.ts`, `api/browse.ts`,
`api/routes/projects.ts`, `api/routes/system.ts` (inspect),
`ui/panel/NewProject.tsx`, `ui/panel/DirectoryPicker.tsx`.

## How it works

**Start fresh.** You name the project and choose where it goes. The server
previews the folder it will make (the name as a slug, `-2`, `-3` when taken),
and the page sends that path back as `expectedPath`, so the project cannot land
somewhere you did not see. Bonsai makes a bare repository in its own data
folder, an initial commit, and master's checkout in the folder you chose; if any
step fails it removes what it made.

**Start from a folder.** The picker lists folders through the server (a browser
cannot hand over a path) and inspects one only when you press **Select this
folder**. Inspection asks git which repository the folder belongs to — the
nearest enclosing one, so a subfolder of a monorepo becomes the agent's working
folder inside it — refuses linked worktrees, and lists every branch, remote
branch and tag you could start from. Adopting reads that version without
checking anything out: master is Bonsai's own read-only checkout of it, kept by
a hidden ref, and **Include my N unsaved changes** turns your working changes
into a commit that exists only for that ref. A folder in no repository is made
into one: `git init`, then everything in it committed as the first version.

## Findings

### P1 · High · verified — Starting from a folder that is not in git commits everything in it, dependencies and secrets included

For a folder in no repository, adoption runs `git init`, `git add -A` and a
commit **in your folder** (`git/adopt.ts:276-295`). With no `.gitignore` — the
usual state of a folder that was never in git — that is everything: an ordinary
JavaScript project with a `.env` and 20,000 files of `node_modules` became a
first commit of 20,003 files. The `.env`, with its (fake) Stripe key, is now in
git history, where the first `git push` from that folder would publish it. Its
`.git` is 84 MB, and every experiment's folder is a full 80 MB checkout, because
`node_modules` is now tracked. A real `node_modules` is often several hundred
megabytes and 100,000 files, so the same folder costs minutes to adopt and half
a gigabyte per experiment.

The page's guard does not catch it. It warns "That is a lot of files" when the
folder has more than 400 **top-level** entries (`NewProject.tsx:408`); this
folder has 4. And it sits under the line "Your folder is never changed".

Reproduce: `node scripts/audit/plain-folder.mjs`.

**Fix (M).** The pieces exist. Before the first commit, write the names Bonsai
already treats as regenerated — `REBUILT_DIRS` in `archive.ts` and `NEVER_COPY`
in `git/seedWorktree.ts`, which should become one shared list — and `.env*`
into `.git/info/exclude`: local to that repository, invisible, and not a file
in your folder. Preset the project's copy-in files to the `.env*` files found,
so experiments still get them. Have inspection report what the first version
would hold (file count and size, and what is left out) and show that instead of
the entry count. Say in the page's line that Bonsai keeps its records in the
repository's `.git`.

### P2 · High · verified — Your home folder, or the whole disk, can be chosen, with no warning

The picker opens in your home folder with **Select this folder** beside it.
Inspecting the home folder (21 entries here) or the filesystem root (24)
returns no blocked reason and no size warning, so **Create project** would run
`git init` and `git add -A` over the whole of it — hours of hashing, a copy of
every file inside `.git`, and afterwards every folder under your home belongs to
that repository, which confuses every other tool that asks git.

Reproduce: the last two lines of `node scripts/audit/plain-folder.mjs`.

**Fix (S).** Refuse the home folder and filesystem roots (drive roots on
Windows) as a folder to make a repository in, with a sentence saying why; P1's
size preview covers the less obvious cases.

### P3 · High · verified — A project whose folder is moved or renamed stops working, and says its code is gone

Bonsai records absolute paths — the repository, master's folder, each
experiment's folder — and git records the reverse links in `.git/worktrees`.
Renaming `projects/` to `Projects/` after adopting a repository gave:

- the project opens, but opening an experiment, or its Review, is a 500 with a
  raw git error: `fatal: not a git repository: …/projects/my-app/.git/worktrees/…`;
- branching a new experiment says "The code this experiment would start from
  (commit 826fd11) is no longer in the repository" — which is false: nothing is
  lost, the folder moved;
- nothing notices the move or offers a way to fix it.

The same applies to a project Bonsai created in a folder you chose, if that
folder moves. Moving and renaming project folders is ordinary tidying, and git
has a command for exactly this case (`git worktree repair`).

Reproduce: `node scripts/audit/moved-folder.mjs`.

**Fix (M).** When a project's repository path is missing, say so when the
project is opened — "This project's folder was at … and is not there any more"
— with **Locate folder**. Accept the new location only if it is the same
repository (the project's `refs/bonsai/<project>/` refs are in it), then update
the stored paths and run `git worktree repair` for every experiment folder. Until
then, report "folder not found" rather than "commit no longer in the
repository".

### P4 · High · verified — Commit signing in your git config breaks every run

Bonsai commits with its own name but your git configuration. With
`commit.gpgsign = true` in `~/.gitconfig` — common among developers — and no
usable key, every run ends *interrupted* with "gpg failed to sign the data".
With a working key, every run signs as "Bonsai" with your personal key, prompting
for a passphrase or a hardware-key touch each time. Adopting a folder not in git
fails the same way, **after** `git init` and `git add -A`: the folder is left
with a `.git` and everything staged, and the next attempt fails identically.

Reproduce: `node scripts/audit/commit-signing.mjs`.

**Fix (S).** Bonsai's own commits are internal records: pass
`-c commit.gpgsign=false` on them (initial commits, run commits, snapshots). If
adoption fails after Bonsai ran `git init`, remove the `.git` it made — nothing
else has used it yet. Your hooks run on Bonsai's commits too; that belongs to
phase 4.

### P5 · Medium · verified — Names in Arabic, Japanese or with accents become "project", "project-2"

The folder name keeps only `a-z` and `0-9` (`slugify` in `projects.ts`):

| Project name | Folder |
|---|---|
| توقعات المبيعات | `project` |
| تجربة الدفع | `project-2` |
| 日本語プロジェクト | `project-3` |
| Café résumé | `caf-r-sum` |

The same rule names Apply's patch files, so an Arabic experiment's patch is
`experiment-<commit>.patch`.

**Fix (S).** Keep Unicode letters and digits (`/[^\p{L}\p{N}]+/gu`), remove only
what file systems reject (`<>:"/\|?*`, control characters, trailing dots and
spaces on Windows), and cap the length in bytes rather than characters.

### P6 · Medium · verified — "Include my unsaved changes" re-reads the whole repository

The snapshot builds a temporary index from `HEAD` and runs `git add -A` into it
(`git/snapshot.ts`). A fresh index has none of git's cached file information,
so git re-reads and hashes every file, not only the changed ones. On a 40,000
file repository with one change: `git status` 40 ms, the snapshot 1,340 ms, the
same snapshot started from a copy of the real index 84 ms. The difference grows
with the repository and with slower disks.

Reproduce: `node scripts/audit/snapshot-cost.mjs`.

**Fix (S).** Copy `.git/index` into the temporary folder instead of
`read-tree HEAD`; the result is the same tree.

## What is solid

- **Your folder is only read when it is a repository.** Nothing is checked out
  or switched; choosing another branch reads it in place; the unsaved-changes
  snapshot never touches your index or refs; a hidden ref keeps what the
  project started from.
- **Created projects cannot land somewhere unexpected.** The destination is
  previewed and must match on submit; an existing folder is never reused; a
  failed creation removes what it made.
- **Subfolders, symlinks and short Windows names** resolve to the right
  repository and working folder (fixed in the previous round, and tested).
- **Shallow clones work end to end** — inspect, adopt, two levels of
  experiments, both Review views, and Apply back into the clone. Checked here.
- **Detached checkouts** are offered as a start point, and linked worktrees
  are refused with the path of the real repository.
- **The picker only selects on purpose** (the earlier audit's F04 is fixed),
  and repositories with thousands of tags list the newest 30.

## Handed to later phases

- Your git hooks (`pre-commit`, `commit-msg`, `core.hooksPath`) run on every
  commit Bonsai makes in your repository's experiments. → phase 4.

## Fix first

P4 and P2 are small and each can stop someone at the first step. Then P1, the
one most likely to happen by accident, and P3.
