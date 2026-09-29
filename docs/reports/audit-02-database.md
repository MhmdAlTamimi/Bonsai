# Audit phase 2 — the database

2026-09-29, `main` at 5842b8c. Opening and upgrading the database, the schema,
the stores and how the data grows.

Files: `db/open.ts`, `db/schema.sql`, `db/migrations.ts`, `db/store.ts`, the
seven `*Store.ts` files, `db/views.ts`, `db/rows.ts`.

## How it works

One SQLite file, `bonsai.db` in the data folder, opened once through
`node:sqlite`'s synchronous API: every query runs on the server's only thread.
Opening runs `schema.sql` (all `CREATE … IF NOT EXISTS`, plus WAL mode and
foreign keys), reads the schema version from `meta`, and if it is older, copies
the file to `bonsai.db.v<N>.backup` and applies the numbered migrations — each
in its own transaction, recording the version as it goes. A database newer
than the code is refused with a clear message.

Eleven tables. `project` → `node` → `run` → `message` hold the tree and every
conversation; `question`, `reference` and the four `comparison*` tables hold the
rest. Invariants that matter are `CHECK` constraints — every experiment has a
pinned base, a commit always has a ref — and derived facts (writable, frozen)
are computed on read rather than stored.

## Findings

### D1 · High · verified — The pre-upgrade backup can be empty

The backup before a migration is `copyFileSync(bonsai.db)` (`db/open.ts:43`).
In WAL mode, recent writes live in `bonsai.db-wal` until SQLite checkpoints
them — every ~4 MB of writes, or on a clean close. The copy leaves that file
behind.

Tested: a session that writes and then ends without a clean close, followed by
an upgrade. The live database has everything (SQLite replays the WAL); the
backup has no tables at all. A clean close is also less common than it looks —
closing the terminal window, a crash, or shutting the laptop all skip it, since
only SIGINT and SIGTERM are handled.

So the one copy meant to save you from a failed upgrade misses your most recent
work at best, and everything at worst. It also matters for rolling back: the
older build refuses the upgraded database (correctly), and this backup is then
the way back.

**Fix (S).** `db.prepare('VACUUM INTO ?').run(backup)` instead of the file
copy: a complete, consistent copy, WAL included. Checked against the same
crash: all 50 experiments are in it, and a quote in the path is harmless
because the path is a parameter. Add the reproduction below as a test.

Reproduce: `npm run build:server && node scripts/audit/backup-after-crash.mjs`.

### D2 · High · verified — Deleting freezes the whole app, for longer the more you have used it

`message.run_id` cascades from `run` but has no index (`schema.sql:219`).
Deleting a run makes SQLite look for its messages, and without an index that is
a scan of every message in the database — once per run deleted. Because every
query runs on the server's only thread, nothing else happens meanwhile: no page
updates, no requests, no agent events.

Measured with 60 experiments × 20 runs × 150 messages (180,000 messages; a real
run writes a message per tool call and one per result):

| | Without the index | With it |
|---|---|---|
| Delete one experiment (20 runs) | 0.61 s | 0.06 s |
| Delete the project (1,200 runs) | 15.9 s | 1.1 s |

The cost grows with runs deleted × messages stored, so it gets worse the longer
Bonsai is used. Reproduce: `node scripts/audit/delete-cost.mjs`.

**Fix (S).** `CREATE INDEX IF NOT EXISTS message_run_idx ON message(run_id)` in
`schema.sql`. That file runs on every open, so existing databases get it at
next start. Index the other child columns with the same shape while there:
`question(run_id)`, `comparison_message(turn_id)`,
`comparison_experiment(node_id)` and `reference(source_node_id)` — the last two
are checked on every experiment deletion.

One caution for whoever adds indexes: `schema.sql` runs **before** migrations,
so an index on a column a migration adds would fail on older databases.
`run_id` has existed since the first schema, so this one is safe.

### D3 · Medium · by reading — A run's end is recorded in several separate writes

Only two places in the data layer use a transaction (migrations, and one
project write). Ending a run is `recordCommit`, then `finishRun`, then
`setSessionPosition`, then the node status (`jobs/runNode.ts:798-834`), each
its own commit. A crash between them leaves, for example, the commit recorded
but the run still "running" — so the next start calls a finished run
interrupted. The window is small; the git half of the same problem (commit and
ref moved, database not yet told) cannot be closed by a transaction at all.

**Fix (S for the database half).** Wrap the run-ending writes in one
transaction. The git half needs startup reconciliation, which phase 5's chaos
tests will measure — treat this as input to that phase rather than fixing it in
isolation.

## Checked, and not a problem

- **Upgrades and rollbacks.** Per-step transactions; a database newer than the
  code is refused with a clear message. Rolling back a change that migrated
  the database therefore needs the backup — which is why D1 matters.
- **Tree reads.** 8 ms for 500 experiments over HTTP; the whole-project queries
  replaced the old per-node ones (see the M6 health review).
- **Write cost.** Every write is its own transaction and waits for the disk
  (`synchronous=FULL`): 0.22 ms per message here, against 0.06 ms with
  `NORMAL`. Not significant at today's volumes; worth revisiting only if
  profiling on a slow Windows disk says otherwise.
- **Growth.** About 10 KB per stand-in run; tool output is trimmed before it is
  stored. The file never shrinks after deletions (no `VACUUM`), which matters
  only after deleting very large projects.
- **Invariants in SQL.** The `CHECK` constraints mean a bug elsewhere cannot
  write an experiment without a base, or a commit without a ref.

## Handed to later phases

- Integrity checking (`PRAGMA quick_check`) and what a damaged database looks
  like to you; export and restore → phase 6.
- Two copies writing one database: there is no `busy_timeout`, so the second
  writer fails at once with "database is locked". Irrelevant once phase 1's S1
  lock exists.

## Fix first

D1 and D2: both one-line changes with a test each, and both protect data or
responsiveness that users cannot get back.
