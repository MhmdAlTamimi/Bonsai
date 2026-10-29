# Archived architecture: one checkout per experiment

This describes Bonsai immediately before shared checkout became the default.
It is a reference for future design work, not the current installation guide.

## Source snapshot

- Archive reference: [archive/pre-shared-checkout](https://github.com/MhmdAlTamimi/Bonsai/tree/archive/pre-shared-checkout).
- Exact commit: [28005fb437d0a7c6174402de64c3ed44ef811f1f](https://github.com/MhmdAlTamimi/Bonsai/commit/28005fb437d0a7c6174402de64c3ed44ef811f1f).
- Database schema: **28**. The original audit baseline, `5842b8c`, used schema **20**.

The archive reference is intentionally kept separate from active development.
The pinned commit also remains in main's ancestry. To inspect the exact implementation:

```bash
git fetch origin
git show 28005fb437d0a7c6174402de64c3ed44ef811f1f:packages/server/src/projects.ts
git show 28005fb437d0a7c6174402de64c3ed44ef811f1f:packages/server/src/archive.ts
git show 28005fb437d0a7c6174402de64c3ed44ef811f1f:packages/server/src/jobs/runNode.ts
```

## System layout

The application was already a modular monolith: React, a local Node.js API and scheduler,
SQLite stores, a Claude SDK adapter, Git, and filesystem storage.

SQLite held projects, nodes, conversations, runs, settings-related metadata, owned session
UUIDs, and durable save/deletion intents. Git held source history and hidden node refs.
Worktrees provided separate working folders, not independent copies of all Git history.

| Area | Previous behavior |
| --- | --- |
| Working folder | One allocated checkout per experiment; the root could have one too. |
| Code version | Each node pinned a base and saved tip through its hidden ref. |
| Dependencies | Each folder could install its own ignored environment/build outputs. |
| Setup | Ran on first writable use, and after a removed checkout was recreated. |
| Concurrency | Separate experiment folders allowed same-project jobs to overlap within the global limit. |
| External editor | An experiment had a stable independent folder while allocated. |
| Inactive experiment | Its folder could remain on disk until archived. |
| Archive | Removed a safe owned checkout; retained records, refs, code, and conversations. |

## Creating a project

A fresh project used a managed bare repository plus the root's working checkout.
Its location could be chosen by the user.

An existing Git repository retained its own checkout and branch. Bonsai added app-owned
refs and detached worktrees, and recorded an adoption snapshot.
The adopted root was read-only and did not follow later source changes.
Older installations could retain the user's checkout as the read-only root; ownership
checks excluded that folder from app deletion and archiving.

Plain folders were snapshotted into managed Git storage without initializing or staging
the original folder. Optional uncommitted snapshots used an isolated index.

## Creating and allocating a node

1. Record the parent, pinned code base, inherited conversation cut, and per-node folder path.
2. Create the hidden ref `refs/bonsai/<project>/<node>` at its saved code.
3. Allocate the node's detached worktree when required; some older flows allocated eagerly.
4. Initialize its pinned submodules.
5. Copy only explicitly configured, ignored copy-in files.
6. Before a writable run, execute the project's setup command if no valid setup stamp exists.

A checkout materialized **all tracked repository files**, including files the experiment
never changed. Git objects/history were shared; ignored dependencies and generated outputs
were regular independent files in each checkout.

## Running and saving

The scheduler reserved a global execution slot for the node. The SDK worked inside that
node's folder, or the project's chosen subdirectory. Questions, retries, and owned background
work remained part of the run.

Before execution, save, or deletion, Git checks compared the recorded identity and refs
with actual state. The agent was not supposed to create branches or worktrees.
Bonsai created commits, recorded durable save intent, and guarded ref updates.
A conversation-only run did not create an experiment code commit merely for its run notes.

Children retained their creation-time code and conversation seeds. Later parent changes
did not update existing children. Session ownership was independent of the folder path.

## Reviewing and applying

Review compared the experiment with its pinned base. Whole-line scope included ancestors'
changes since leaving the root. Comparisons used exported committed snapshots and could
not mutate experiment folders.

Apply exported a patch and showed the user's command; Bonsai did not merge into the
original repository. These product semantics continue under shared checkout.

## Archiving and recovery

Manual or idle archiving first checked ownership, active work, unfinished files, Git identity,
and locks. It removed the registered app-owned checkout while retaining saved commits,
hidden refs, conversations, and session records.

Ignored files were not saved by Git. Manual archiving warned that ignored data in the
removed folder could be lost; the archived code alone did not reconstruct installed
dependencies or valuable ignored outputs. On a later run, Bonsai recreated the folder at
its recorded path and reran setup.

Interrupted work used explicit recovery rather than silent resets. Backups, relocation,
deletion journals, and independent exports protected saved and unfinished work.
A saved database alone could not reverse filesystem changes made later.

## Why the default changed

Separate checkouts made concurrent experiment work straightforward, but multiplied full
working files, installed environments, and build outputs. Archive helped only after a
checkout was removed; several live experiments could still consume substantial disk space.

Shared checkout retains independent code histories and conversations while materializing
one project's code at a time. The cost is serialized same-project runs, explicit holds for
external editors/previews, and setup/rebuild time when switching environments.
Unclassified ignored outputs remain preserved, so shared checkout does not eliminate
every source of disk growth.

## Reuse safely

Use this snapshot to study or reimplement the architecture. To execute it, use a separate
data and repository location, or a suitable complete pre-upgrade backup.
The archived schema-28 executable must not open a schema-29 database.
Do not lower the schema version or copy an old database over converted workspace state.

Current code retains the old flow only for unconverted projects, with regression coverage.
See [current architecture](../architecture.md) and [conversion](../storage.md#convert-an-existing-project).
