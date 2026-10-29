# Audit phase 13 — sharing between experiments

2026-10-03, `main` at 5842b8c. The ways one experiment's work reaches
another: references (shared text, `@name` in a message), mentioning another
experiment with `@`, comparisons, and *Start from latest* for an experiment
that is behind. Looked at in Chromium on the phase 10 fixture, and measured
on a larger repository.

Files: `jobs/runContext.ts`, `jobs/experimentSnapshot.ts`,
`jobs/comparisonSnapshot.ts`, `jobs/comparisons.ts`,
`api/routes/comparisons.ts`, `api/routes/references.ts`, `archive.ts`
(`storageUse`), `api/routes/projects.ts` (`/usage`),
`state/useComparePicking.ts`, `state/useChildCreation.ts`,
`chat/Mentions.tsx`, `compare/ComparePage.tsx`.

## How it works

- **References** are project-wide text. A run given one receives it as a
  read-only file in the run's own folder and keeps that copy; the thread says
  when the reference was edited or deleted since, and opens the exact copy the
  run read.
- **`@` an experiment**, and the run receives a snapshot of its committed
  work: its conversation (up to 1 MB), its committed changes as a diff (up to
  2 MiB) and its notes — saying what it left out (a run in progress,
  uncommitted files).
- **A comparison** of two to four experiments snapshots each the same way,
  plus *its whole repository at that commit*, and offers a read-only agent to
  ask about them. *Update* re-takes a snapshot when an experiment has moved
  on.
- **Start from latest** creates a new experiment on the parent's current code,
  with the experiment that is behind attached, to redo its change there.

## Findings

### X1 · Medium · verified — Every comparison keeps a full copy of each compared experiment's repository, and nothing counts or removes them

`compare-cost.mjs` compared three experiments of a folder of 20,000 files
(88 MB):

- creating the comparison took 1.4 s (the request waits for it) and **left 237
  MB** in the project's `compare/` folder — one exported tree per experiment;
- *Update* after one experiment moved on took 3.0 s and wrote them again;
- Settings › Storage counts experiment folders only (`archive.ts:208-228`):
  these copies are not shown anywhere;
- they stay until the comparison is deleted, and comparisons are kept per
  project by design.

On a repository with assets — images, datasets, fixtures — each comparison is
gigabytes, and a project that compares often accumulates them unseen.

Reproduce: `node scripts/audit/compare-cost.mjs`.

**Fix (M).**

- Export a compared experiment's files only when the comparison is first
  asked something, and remove the exports of comparisons left idle (as idle
  experiment folders are archived), keeping their conversation; re-export on
  the next question.
- Count comparison and run-attachment copies in Settings › Storage, per
  project, with a way to clear them.

### X2 · Medium · by reading — Spending on comparisons and on drafted references is not in Usage

Usage lists each experiment's runs (`routes/projects.ts:80-100`). Two other
things spend model tokens and are left out:

- **Comparison questions** record a cost per turn (`comparisonStore.ts:185`)
  but it never reaches Usage. Each question gives the agent up to four
  experiments' conversations, diffs and repositories to read.
- **Save as reference** drafts its text with a model call that can send up to
  240,000 characters of conversation (`DRAFT_BUDGET`), and records no cost at
  all.

With phase 7's A1 (each run's cost counted again in later runs), Usage is
wrong in both directions.

**Fix (S).** Add comparison turns to the project's Usage as their own
section, record the draft call's cost (its result carries it), and apply
A1's correction to comparison turns too — they resume their session in the
same way.

### X3 · Low · verified — A comparison's address does not open it

The address bar records the open comparison (`?project=…&compare=…`), but
loading that address lands on the map: the address is rewritten to
`?project=…&node=…` and the comparison is dropped. A reload on the Compare
screen therefore loses it. The cause is in `useComparePicking.ts`: the
project id starts as null while the project loads, and its first change is
treated as switching project, which clears the comparison.

**Fix (S).** Clear the comparison only when the project changes from one
project to another, not when it is first known.

### X4 · Low · by reading — *Start from latest*, saved for later, loses the work it carries

The dialog pre-fills "Redo the change from @*name* on this code" and the
experiment that is behind is attached — but only to a run started now
(`useChildCreation.ts:100-104`). Choosing *Save for later* keeps the request
text and drops the attachment, so when the first run is started later the
agent reads "@*name*" with nothing to read.

**Fix (S).** Save the attachment with the new experiment's draft, as an `@`
added by hand is kept.

## What is solid

- **A run keeps exactly what it was given.** References and experiment
  snapshots are read-only files in the run's own folder; the thread marks a
  reference edited or deleted since and opens the copy the run read.
- **An `@` experiment is bounded and honest**: committed work and finished
  runs only, capped at 1 MB of conversation and 2 MiB of diff, and it says
  what it left out.
- **Comparisons only read**, by the tools offered and by the permission
  callback both, and say so on the screen.
- **The Compare screen is clear**: each experiment's goal, recorded testing,
  approach and changes side by side, suggested questions, and *Reads only*.
- **Deleting an experiment names the comparisons that include it** first, and
  they keep the copy they read.
- **Nothing is saved without you**: *Save as reference* opens an editor and
  saves only when you do.

## Fix first

X2 with phase 7's A1, so Usage can be trusted. Then X1 before people compare
experiments of large repositories. X3 and X4 are small.
