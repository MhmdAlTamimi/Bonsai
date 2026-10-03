# Audit phase 6 — backups, export, moving machines

2026-10-03, `main` at 5842b8c. What Bonsai keeps and where, what a backup of
it needs, whether a backup can be put back, moving to another computer, user
name or drive, and taking work out of Bonsai. Per the plan, copies were also
checked with SQLite's own integrity check.

Files: `config.ts`, `settings.ts`, `db/open.ts`, `db/migrations.ts`
(`DatabaseTooNewError`), `db/schema.sql`, `agent/ClaudeSdkRunner.ts`,
`jobs/conversation.ts`, `jobs/runNode.ts`, `git/exec.ts`, `api/applyPatch.ts`,
and the README's "Configuration and data".

## Where your work is

The data folder is `~/.local/share/bonsai`, `~/Library/Application
Support/Bonsai` or `%LOCALAPPDATA%\Bonsai`, or `BONSAI_DATA_DIR`.

| What | Where | Anywhere else? |
| --- | --- | --- |
| Projects, experiments, runs, every conversation as shown, project settings | `<data>/bonsai.db` (and `-wal`) | no |
| App settings, including a stored API key | `<data>/settings.json` | no |
| A project Bonsai created: its repository and master's folder | `<data>/repos/<project>/` | **no — the code exists nowhere else** |
| Each experiment's code, on its hidden ref | that repository; for a project you added, **your own repository** | no |
| Experiment folders | `<data>/repos/<project>/worktrees/` | rebuilt from the refs, except uncommitted work |
| Patches from Apply | `<data>/patches/`, kept a week | — |
| Logs | `<data>/logs/` | — |
| The agent's session for each experiment: what lets the next run carry on, and what a child's conversation is copied from | **`~/.claude/projects/`**, Claude Code's folder | no |

The one backup Bonsai makes is a copy of `bonsai.db` before a migration
(phase 2's D1: that copy misses the `-wal` file and came out empty). There is
no backup, restore, export or move in the app. The README says to "preserve
the database, repositories and recorded checkout locations", and the only
export is Apply's patch, which carries one experiment's code and not its
conversation.

## Findings

### B1 · High · verified — Moving the data folder breaks every project, and says your code is gone

Every location is recorded as an absolute path: the repository, the scratch
folder and master's folder on each project, and the folder on each
experiment. Git's links are absolute too: each experiment folder's `.git`
file names its repository by full path, and the repository names the folder
back.

In the test, a home folder was renamed (`alice` to `alice-laptop`), which is
what copying it to a computer with another user name amounts to. Moving to
another drive is the same. Eight paths in the database still pointed at the
old place. Bonsai started, listed the projects and drew the maps, then:

- opening, reviewing or running an experiment failed with HTTP 500
  `git status --porcelain -z --untracked-files=all failed: ` and nothing more
  (see B5);
- Apply failed with HTTP 500 `git merge-base … failed: `;
- running the archived experiment said "This experiment's code (commit
  d69c0a9) is no longer in the repository". It is still there, at the new
  path;
- branching from an experiment said "The code this experiment would start
  from (commit b91499b) is no longer in the repository";
- deleting the project failed with HTTP 500, so it cannot even be cleaned up
  from the app.

Moving is ordinary: a new computer, a full system drive, a changed user name.
Projects Bonsai created are the worst off, because the data folder holds the
only copy of their code.

Reproduce: `node scripts/audit/move-data.mjs`.

**Fix (M).**

- Record what Bonsai owns relative to the data folder (repositories, scratch
  folders, master's folder for a created project, every experiment folder) and
  resolve it when read. A migration rewrites existing rows.
- At startup, when a project's recorded locations are missing, mark the
  project and offer to locate it, instead of failing each request. After a
  move, run `git worktree repair`, which git provides for exactly this.
- For folders of your own, phase 3's P3 fix: find the repository again by
  its identity.

### B2 · High · verified — A backup taken while Bonsai runs gives back broken experiments, and Bonsai offers no safe one

Most backup tools copy files one at a time while the computer is in use: sync
folders, `rsync`, `cp` and many backup apps. Copying the data folder that way
while runs were saving: `live-copy.mjs` took eight copies while four
experiments kept running, put each copy back and ran every experiment once.
Across three runs of the script:

- SQLite's `PRAGMA integrity_check` passed on every copy. The database is not
  the problem.
- 9, 12 and 13 of the 32 experiments could not run, and in the two runs
  counted per copy, 6 and 7 of the 8 copies had at least one. The errors were
  `fatal: bad object HEAD` (the folder's position was copied after the
  commits) and `error: invalid object … for 'notes/…'` (the index names a file
  the copy does not have). Bonsai cannot recover from either.
- One copy failed outright, because one of git's lock files vanished while it
  was being copied.

A git repository is not safe to copy while it is being written, and Bonsai
writes all the time: every run ends in a commit. Tools that copy from a
file-system snapshot avoid this (Time Machine on APFS works this way); tools
that copy file by file do not.

Whether the data folder is backed up at all also depends on the platform. On
Windows it lives in `AppData\Local`, and Windows' own backup covers folders
such as Documents and Desktop by default, not `AppData`. That is not tested
here, but if it holds, a created project there has no backup unless you set
one up.

Reproduce: `node scripts/audit/live-copy.mjs`.

**Fix (M).** One format can serve backup, moving and handing a project to
someone:

- **Back up / Export project**: one file holding the project's database rows,
  a `git bundle create --all` of its repository (one consistent file, hidden
  refs included), and the agents' session files (B4). It is taken between
  saves: the save path holds a lock the backup waits for.
- An automatic daily backup of the same kind in the data folder, keeping the
  last few.
- **Restore / Import**: unbundle into the repositories folder and insert the
  rows with paths resolved locally (B1).
- Until then, add one line to the README: stop Bonsai before copying its data
  folder.

### B3 · Medium · verified — Putting back an older database leaves stuck experiments and leftovers nobody can see

The restore Bonsai invites is its own pre-upgrade backup. An older Bonsai
refuses a newer database ("Update Bonsai rather than running this build
against it") and does not say that a backup exists or where it is. The same
happens with any backup of the database file without the repositories.

`restore-older.mjs` backs up the database, runs one experiment again, makes a
new one, and puts the backup back:

- **The experiment that ran again is stuck.** Its next run, and Discard, say
  "This experiment's saved code changed outside Bonsai". This is the same dead
  end as phase 5's R1. Its last run's work is in the repository, and nothing
  in the app can reach it.
- **The experiment made after the backup is gone from the map**, but its
  folder and ref stay on disk and in the repository, and nothing will ever
  remove them.
- An experiment untouched since the backup works.

Reproduce: `node scripts/audit/restore-older.mjs`.

**Fix (M, with R1).**

- Generalise the reconciliation proposed for R1: when an experiment's ref is
  ahead of the database only by commits Bonsai made for that experiment, catch
  up, and record those runs as ones whose conversation was lost.
- At startup, list refs and folders that no experiment owns, and show them in
  Settings with a remove action.
- Have the "newer database" message name the backup file and say what
  restoring it costs.

### B4 · High · verified in code and with the SDK — An experiment's conversation lives in Claude Code's folder, where it is not backed up, not moved, and deleted after 30 days

Bonsai shows each conversation from its own database. The agent's memory of
it lives elsewhere: Claude Code's session file in `~/.claude/projects/`.
That file is what lets the next run carry on (`ClaudeSdkRunner.ts:222`
resumes it by id) and what a child's conversation is copied from
(`forkConversation`).

- A backup or move of Bonsai's data folder does not include it.
- **Claude Code deletes transcripts older than 30 days by default**
  (`cleanupPeriodDays`):
  - Bonsai's own runs skip that sweep. They run with no settings sources, and
    the CLI's code skips retention when user settings are off.
  - When you run Claude Code yourself, its sweep goes through every folder
    under `~/.claude/projects`, Bonsai's included. Only Claude Desktop's
    sessions are exempt.
  - Bonsai's users are Claude Code users, so an experiment left alone for a
    month loses its session.
  - All of this is read from the bundled Claude Code 2.1.283's code and its
    documented default. The sweep did not fire in a short interactive session
    in this sandbox.

What follows was checked by calling the SDK as Bonsai does, with a session id
that does not exist:

- every run of that experiment fails with "Claude Code returned an error
  result: No conversation found with session ID: …" and the experiment
  becomes interrupted;
- Resume fails the same way, and nothing in Bonsai lets the experiment start
  its conversation over;
- branching from it gives a child without its conversation ("Could not copy
  … conversation").

**Fix (M).**

- When the session is missing, do not fail. Start a new session, give the
  agent the conversation Bonsai already holds in its database (condensed),
  and tell the user once. The session then becomes a cache rather than the
  only copy.
- After each finished run, keep a copy of the session file in the data
  folder, so backups and moves include it, and put it back before resuming if
  Claude Code's copy is gone.

### B5 · Medium · verified — A missing folder is reported as an empty git error

When git is started in a folder that does not exist, Node cannot start it,
and the error's `stderr` is an empty string. `git/exec.ts:84` builds the
message from `e.stderr ?? e.message`. An empty string is not null, so the
reason is dropped and the message ends at "failed: ". This is what phase 5's
R2, phase 3's P3 and B1 above all look like to the user.

**Fix (S).** Check the working folder first and say "The experiment's folder
is missing: <path>". Use `||` so other start-up errors keep their message.
Node's own message for this case, "spawn git ENOENT", would wrongly suggest
that git is not installed.

## What is solid

- **The database survives being copied.** SQLite in WAL mode passed its
  integrity check on every copy taken while it was being written.
- **Settings are written safely**: to a temporary file, then renamed, with
  owner-only permissions.
- **An older Bonsai refuses a newer database** rather than quietly damaging
  it.
- **Changing where new projects go never moves existing work**: locations are
  pinned per project.
- **What Bonsai hands out is standard**: Apply's patches are ordinary
  `git apply` patches, and a created project is an ordinary git repository
  that can be pushed, cloned or bundled.

## Learning note — why "copy the folder" is not a backup

A backup must be one moment in time. Copying files one by one gives each file
a different moment, and two stores that must agree — SQLite and git here —
then disagree. There are three ways out, from the outside in:

- **File-system snapshots** (APFS, Windows VSS, LVM, ZFS, btrfs) freeze the
  whole disk at one instant.
- **Application snapshots** ask each store for a consistent copy: SQLite's
  `VACUUM INTO` and git's `bundle`.
- **Quiescing** pauses writes while the copy is taken.

SQLite's write-ahead log is why the database came through every copy intact.
Git's loose files have no such protection. This is the same "two stores, no
shared transaction" problem as phase 5's R1, seen from the backup side.

## Handed to later phases

- `settings.json` holds the API key in plain text, readable only by you, so
  every backup or copied data folder carries it → phase 15.
- Disk use of the data folder → phase 17.

## Fix first

1. B4's fallback, starting fresh from the stored conversation: small, and it
   turns a time bomb into a notice.
2. B5, which is one line.
3. B1 and B2 as one piece of work: relative paths, and a project bundle used
   for backup, export and import.
4. B3 rides with R1's reconciliation.
