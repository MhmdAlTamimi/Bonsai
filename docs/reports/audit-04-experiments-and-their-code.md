# Audit phase 4 — experiments and their code

2026-10-03, `main` at 5842b8c. Creating an experiment, its folder, copy-in
files and the setup command, hidden refs, commits, and the checks that stop
Bonsai touching what it does not own. Also, per the plan: git's own
housekeeping, your git configuration and hooks, submodules, LFS, line endings,
long Windows paths, and several experiments committing at once.

Files: `projects.ts` (`createChildNode`, `allocateNodeWorktree`),
`git/worktree.ts`, `git/seedWorktree.ts`, `jobs/setup.ts`, `git/refs.ts`,
`git/commit.ts`, `git/ownership.ts`, `git/exec.ts`, `git/context.ts`,
`domain/lineage.ts`, `ui/canvas/NewChildDialog.tsx`.

## How it works

**Creating** an experiment is cheap and makes no folder: Bonsai pins its base
(its parent's latest commit), checks git still has that commit, writes the row
and creates its hidden ref `refs/bonsai/<project>/<node>`. The branching dialog
says what it inherits — that code, and the parent's conversation up to its last
finished run, or none if you choose **Start fresh**.

**The folder** is made on the first run (or Open folder): `git worktree add
--detach` at the base, in Bonsai's data folder; then the copy-in files (`.env`
and the like: ignored files git does not check out) are copied from your
folder, and before the agent starts, the setup command (`npm install`, `uv
sync`) runs once, in the agent's working folder.

**After each run**, `commitRunOutput` decides whether anything changed — the
run notes in `CONTEXT.md` do not count — and if so runs `git add -A` and `git
commit` in the experiment's folder, then moves the ref from the old commit to
the new one, which git refuses if the ref moved meanwhile. Before and after,
`assertGitState` checks the folder is still on the commit, branch, repository
and ref Bonsai recorded; anything else is reported as drift and never repaired.

## Findings

### G1 · High · verified — Your git hooks run on Bonsai's commits, and a failing one stops every run

Bonsai's commits run your hooks, from your repository (`.git/hooks`, husky's
`core.hooksPath`) and from your global config (`git/commit.ts:135-136`).

- A pre-commit hook that fails — as husky does in a folder where `npm install`
  has not run, or as a linter does on code it does not like — fails the commit,
  and the run ends *interrupted* with "git commit -m try failed: husky -
  pre-commit script failed". The work stays uncommitted in the folder.
- A `core.hooksPath` in `~/.gitconfig` does the same in projects Bonsai created
  itself.
- Your post-checkout hook ran inside the experiment's folder in Bonsai's data
  folder, when that folder was made.

Together with commit signing (phase 3, P4), anyone whose git is set up for
team rules — hooks, signing — finds runs failing for reasons that have nothing
to do with the agent's work.

Reproduce: `node scripts/audit/git-environment.mjs hooks` and `… global`.

**Fix (S).** Bonsai's commits are its own records of a run, not your commits:
run them without your hooks (`-c core.hooksPath=<an empty folder Bonsai owns>`,
which also covers post-checkout and post-commit) and without signing. Your
hooks then run where they belong: when you commit after Apply.

### G2 · High · verified — With `diff.noprefix` in your git config, Apply writes files to the wrong place and says it worked

The patch is made with `git diff` (`api/applyPatch.ts:75-78`), which follows
your git configuration. With `diff.noprefix = true` — a setting some
developers prefer — the patch has no `a/` and `b/` prefixes, but `git apply`
still removes the first part of every path. Tested: `notes/try-it.md` was
applied as `try-it.md` at the top of the repository, and the command reported
success. A change to `src/index.js` would be applied to a top-level
`index.js` if there is one — another file, silently.

Reproduce: `node scripts/audit/git-environment.mjs noprefix`.

**Fix (S).** Give every diff Bonsai produces for a machine to read explicit
prefixes and no colour or external tool: `--src-prefix=a/ --dst-prefix=b/
--no-ext-diff --no-color`. With G1 and G3 this belongs in one place —
`git/exec.ts` — as a fixed set of overrides on every git command Bonsai runs.

### G3 · Medium · verified mechanism — Bonsai ignores the git settings Windows keeps for you, and honours the ones that break it

`git/exec.ts:38` sets `GIT_CONFIG_NOSYSTEM=1` "to keep the app's git
deterministic". That removes git's **system** configuration and keeps your
**global** one — the reverse of what helps. The global file is where G1's
hooks, phase 3's signing and G2's `noprefix` live. The system file is where
the Git for Windows installer puts settings Bonsai needs:

- **Git LFS's filter.** Tested with a filter defined only at system level: your
  checkout has the real content, the experiment's folder has what git stores
  instead. With LFS that means pointer files where your images, models or
  datasets should be — and an agent editing one would commit it as an ordinary
  file.
- **Long paths** (`core.longpaths`). An experiment's folder is
  `C:\Users\<name>\AppData\Local\Bonsai\repos\<36-character id>\worktrees\<36-character id>\`
  — 139 characters for a typical user name, leaving 121 under Windows' 260
  limit for a path inside the repository. Deep source trees exceed that, and
  checkout then fails with "Filename too long".
- **Line endings** (`core.autocrlf`): experiments check out differently from
  your own folder.

Not run on Windows itself; the mechanism is verified with a system-level
filter on Linux. Reproduce: `node scripts/audit/git-environment.mjs system`.

**Fix (M).** Stop setting `GIT_CONFIG_NOSYSTEM`, and get determinism from the
overrides in G1 and G2 instead. Use shorter folder names for experiments (the
first 8 characters of the id are unique enough within a project), which
matters on Windows whatever the setting.

### G4 · Medium · verified — Submodules are empty in every experiment

`git worktree add` does not check out submodules, and nothing does it
afterwards. In a repository with a `lib/` submodule, your `lib/` has its files
and the experiment's `lib/` is empty — so builds and tests that need it fail,
and the agent is not told why.

Reproduce: `node scripts/audit/git-environment.mjs submodule`.

**Fix (M).** After creating a folder in a repository with `.gitmodules`, run
`git submodule update --init --recursive`, taking the code from the copies
already in your repository (`.git/modules`) so it needs no network. Until
then, tell the agent and the user that this repository's submodules are not
present.

### G5 · Medium · verified — Bonsai's run notes collide with a `CONTEXT.md` of your own

Run notes are written to `CONTEXT.md` at the repository root
(`jobs/runNode.ts:623`), and treated as Bonsai's: a change to that file does not
count as a change, and Apply leaves it out (`api/applyPatch.ts:41`). In a
repository that already has a `CONTEXT.md` — a name AI-assisted projects use
for exactly this kind of file — that means:

- the agent's notes replace yours in the experiment and in every experiment
  branched from it (tested: "Always use pnpm" was gone after one run);
- Review lists `CONTEXT.md` as a change;
- Apply drops any change to it, including one you asked the agent for.

Reproduce: `node scripts/audit/git-environment.mjs context`.

**Fix (M).** Keep notes at a path Bonsai owns, such as `.bonsai/notes.md`, for
new experiments; keep reading `CONTEXT.md` for experiments that already have
notes there.

## What is solid

- **Several experiments committing at once.** Six experiments of one
  repository ran together, three rounds: 18 of 18 committed, every ref in
  place, `git fsck` clean.
- **Git's housekeeping cannot lose work.** With one experiment archived (its
  folder removed), `git gc --prune=now` and `git worktree prune` in your folder
  changed nothing: Review worked, the archived experiment ran again from its
  ref, and Apply applied.
- **Ownership checks.** Ref moves are compare-and-swap; drift is reported, never
  "fixed"; an archived folder comes back at the same path; an occupied
  location is refused rather than reused.
- **Copy-in files** refuse absolute and `..` paths, symlinks, tracked files and
  destinations that would not ignore them, and never copy dependency folders.
- **The setup command** runs once, where the agent works, can be stopped, tells
  the agent when it fails, and names any file it leaves that git can see.
- **The branching dialog** says what an experiment inherits (the earlier UI
  audit's F07 is addressed).

## Handed to later phases

- Disk use: every experiment is a full checkout of the tracked files plus its
  own dependencies. Archiving bounds it; measuring it and the options
  (sparse checkout, shared dependency caches) → phase 17.
- Case-insensitive file systems: a repository with two paths that differ only
  in case collides in every checkout, your own included — not specific to
  Bonsai, noted only.

## Fix first

G1 and G2 together, as one change in `git/exec.ts` with phase 3's P4: fixed
overrides on every git command Bonsai runs. They are small, and between them
they stop runs failing and Apply writing to the wrong file. G3 belongs in the
same change, checked by the Windows CI job.
