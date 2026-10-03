# Audit phase 5 — removing and recovering

2026-10-03, `main` at 5842b8c. Everything that ends or undoes something:
deleting an experiment or a project, archiving and bringing an experiment back,
and what Bonsai does when a run does not finish — stopped, failed, or cut off
because the app itself died. Per the plan, beyond reading the code this phase
used two kinds of test new to the codebase: **chaos testing** (kill Bonsai at
random moments, restart it, check what is left) and **property-based testing**
(random sequences of operations, checked against a model after every step).

Files: `projects.ts` (`deleteNodeTree`, `deleteProjectTree`, `verifyDeletion`,
`projectDeletionImpact`), `archive.ts`, `git/commit.ts`, `git/recovery.ts`,
`git/worktree.ts`, `git/repo.ts`, `jobs/runNode.ts`, `db/runStore.ts`
(`markOrphanedInterrupted`), `api/routes/runs.ts` (`/recover`),
`shared/src/recovery.ts`, `ui/panel/node/Recovery.tsx`,
`ui/panel/node/useNodeActions.ts`.

## How it works

**Deleting** an experiment deletes it and everything branched from it; the
confirmation says how many experiments that is. Bonsai first checks every one
of them — its ref, folder and branch are where it recorded them — and refuses
the whole delete with "Nothing was deleted" if any is not. Then, one experiment
at a time, it removes the folder, the branch if Bonsai made it, and the hidden
ref; then the run notes; and last, one database delete that cascades to the
rows (`projects.ts:477-506`). For a project you added, your folder, branches
and history are never touched.

**Archiving** removes an experiment's folder and keeps its code on its ref. It
is refused when there is uncommitted work, when the folder has drifted, or for
your own folder, and it lists ignored files that would not come back (other
than rebuildable ones such as `node_modules`). The hourly sweeper archives only
what is safe without asking. The next run, or Open folder, recreates the folder
at the same path from the ref.

**A run that does not finish** leaves the experiment *interrupted*. At startup,
any run still recorded as running died with the app and is marked so
(`db/runStore.ts:279-293`). The panel shows the files left in the folder and
the patch, and offers Resume (the agent carries on, told why it stopped and
what is in the folder), Discard (confirmed; puts the folder back to the last
saved commit) or Keep.

**Saving a run** is four separate steps (`git/commit.ts:122-160`,
`jobs/runNode.ts:784-811`): `git commit` in the folder, move the ref to the new
commit, record the commit in the database, record the run as finished.

## Findings

### R1 · High · verified — A crash while a run is saving leaves the experiment stuck for good

If Bonsai dies during the save — a crash, a laptop that runs out of battery, a
closed terminal — the experiment can end up in a state nothing in the app can
get it out of.

What happens: Bonsai is killed while `git commit` runs. The commit is a
separate process, and it finishes after Bonsai has gone. On restart, the folder
is on a commit the database has never heard of — or, a moment later in the
save, the ref has moved too but the database has not. Startup marks the run
"app closed" and the experiment interrupted. Then:

- **Discard** is refused: "This experiment's Git state changed outside
  Bonsai…". Nothing changed outside Bonsai; the commit is Bonsai's own.
- **Resume**, and **Keep** followed by a new run, are refused the same way when
  the next run checks the folder.
- The agent's work is in that commit, but Review does not show it, and the run
  is recorded as closed with no changes.

The only way out is running git commands in Bonsai's data folder.

Chaos test, 80 kills at random moments in a run (seed 12345): 38 runs had
finished before the kill and 42 were interrupted. 25 of those came back with
Discard and a next run. **17 were stuck**, and every one of them was killed
244–365 ms into the run — the save, with the stand-in agent's timings — while
those that recovered were killed 106–248 ms in. In 16 the folder was ahead
of the database; in 1 the ref was too. A seed fixes when the kills happen, not
how fast the machine is, so the counts move a little between runs: an earlier
run of the same seed left 14 stuck.

Kills at every other moment of a run recover well (see What is solid). The
window is the save itself, so it is a fraction of a second with the stand-in
agent's small change; it grows with the size of the change and of the
repository, since `git add -A` and `git commit` hash every changed file.

Reproduce: `node scripts/audit/chaos.mjs 80 12345`.

**Fix (M).** Git and SQLite cannot share a transaction, so make the save
_recoverable_ rather than atomic. Write down the intent before acting: just
before `git commit`, record on the run "saving, from commit X". At startup, a
dead run with that mark is reconciled before anything else looks at it — if
the folder (or the ref) is exactly one commit past X, and that commit's parent
is X and it was made by Bonsai (`bonsai@localhost`, this experiment's message),
it is this run's save: move the ref from X with compare-and-swap, record the
commit, and finish the run with its changes, noting the app closed while
saving. Anything else is still drift, reported and never repaired. Separately,
the message should not say "outside Bonsai" when the only difference is a
commit Bonsai made.

### R2 · Medium · verified — A delete that stops part-way leaves experiments on the map with nothing behind them

Deletion checks everything before it starts, which is right, but then removes
folders and refs one experiment at a time and the database rows only at the
end. Anything that stops it in between leaves the experiments it had already
handled on the map, with no folder and no ref:

- **A folder that cannot be removed.** On Windows that is any folder with an
  open file in it — an editor, a terminal, a virus scanner, a dev server the
  agent started. Simulated with `git worktree lock` on the second of three
  children, the delete of their parent stopped with HTTP 500 and git's own
  message (`git worktree remove --force <path> failed: fatal: cannot remove a
  locked working tree…`). By then the first child had already lost its folder
  and its ref, and all four experiments were still on the map.
- **A crash during the delete.** Killing Bonsai while it deleted an experiment
  with five children (10 rounds, a later moment each round) left one of the
  six on the map without a folder in 1–2 rounds of 10 across runs of the
  script.

Afterwards:

- opening or running those experiments fails with an HTTP 500 and an empty git
  error;
- their code is no longer kept by a ref, so the next `git gc` may remove it —
  in a project you added, that is gc in your own repository;
- the error from the failed delete does not say part of it happened.

Deleting again finishes the job, so nothing you meant to keep is lost; the
problem is the broken state and the misleading messages, and on Windows it
will be common.

Reproduce: `node scripts/audit/partial-delete.mjs`,
`node scripts/audit/kill-during-delete.mjs`.

**Fix (M).** Turn the order around. Once the checks pass, delete the rows in
one transaction — that is the delete the user sees, and it is then
all-or-nothing — and in the same transaction add the folders and refs to
remove to a cleanup list. Then remove them; whatever fails (an open file) stays
on the list, is retried at startup, and if it is still stuck is shown in
Settings ("1 folder Bonsai could not remove: …"). The map then never shows an
experiment that is half gone. `deleteProjectTree` should get the same order.

### R3 · Low · verified — `git fsck` reports every project Bonsai created as broken

`git/repo.ts:37-39` makes the first commit with git's well-known empty tree,
without writing that tree into the repository. Everything that uses the
repository works — push, clone, clone with object checking and bundle were all
tested — but `git fsck` reports `missing tree 4b825dc…` until the first
`git gc`.

That matters because it takes away git's own integrity check: it always fails,
so real damage hides behind a known error. This phase's own scripts had to
filter that line out, and phase 6 (backups) will want `fsck` as a check.

**Fix (S).** Write the tree before using it: `git mktree` with empty input
returns the same id and stores the object.

## What is solid

- **Random sequences keep every rule.** `scripts/audit/model.mjs` makes random
  creates, runs, archive-and-restore and deletes, and after every step checks
  that the map matches the model, every ref matches the database, archive and
  restore give back the same commit at the same path, every delete removes
  exactly what its confirmation listed, and the only experiment folders on disk
  belong to live, unarchived experiments. Over three seeds, 450 random
  operations — 158 creates, 125 runs, 47 archive-and-restores and 79 deletes
  that went through, and 41 archives the archive checks refused — every rule
  held after every step, and `git fsck` was clean apart from R3.
- **Most crashes recover cleanly.** In the chaos test, every interrupted run
  outside the save window came back with Discard and a next run; after all 80
  kills nothing was still recorded as running and no git lock file was left.
- **Recovery says why.** The wording follows the cause (stopped, failed, app
  closed, changed after it finished), the panel shows the actual files and
  patch, and Resume tells the agent what is really in the folder.
- **Discard is careful.** It is confirmed, it checks the folder is where Bonsai
  recorded it before touching anything, and it is refused on your own folder
  (the earlier UI audit's F05 and F27 are addressed).
- **Deletion checks first, and never takes what is yours.** Any mismatch
  refuses the whole delete before anything is removed; your branches, your
  folder and your history are never touched; the confirmation's count is
  exact.
- **Archiving** refuses uncommitted work, drift and your own folder, names the
  ignored files that will not come back, and the sweeper only archives what is
  safe without asking.

## Learning note — chaos and property tests

Both techniques test _rules_ rather than examples, and both found things here
that example-based unit tests could not.

- **Chaos testing** found R1. The bug lives in the gap between two processes —
  Bonsai and the `git` it started — and only appears when one dies at the
  wrong moment. A seeded random generator makes it repeatable: the same seed
  kills at the same moments.
- **Property-based testing** (`model.mjs`) keeps a tiny model of what the tree
  _should_ be and compares the real app against it after every random step.
  The hand-rolled version lacks one thing a library such as
  [fast-check](https://fast-check.dev) adds: _shrinking_. When a run fails at
  step 140, fast-check's model-based testing (`fc.commands`,
  `fc.modelRun`) cuts the sequence down to the shortest one that still fails,
  which is usually three or four steps and makes the cause obvious.

Both take minutes, so they suit a nightly CI job with a random seed that prints
the seed when it fails, rather than every push.

## Handed to later phases

- Deleting a project with many runs is slow because of the missing
  `message(run_id)` index — phase 2, D2.
- Delete is permanent: the refs go, and Bonsai's refs keep no reflog. Whether
  deleted experiments should be kept for a while (a bin), given each one may
  hold paid-for agent work → phase 6, with backups.

## Fix first

R1: it strands the user with no way out from inside the app, after an ordinary
event — the app closing at the wrong moment. Then R2, which matters most on
Windows. R3 is one line and can ride with either.
