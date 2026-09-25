# Bonsai

Bonsai is a local app for visualizing coding experiments, talking to Claude Code agents,
and reviewing their edits. A node holds a conversation and an experiment checkout.
Children inherit a pinned code snapshot and, unless started fresh, a copy of their parent's
conversation, both taken at creation. Code and conversation can come from different
ancestors when the parent changed no files.

## Current behavior

- Create a new project or adopt an existing repository. New projects use a Bonsai-owned
  bare repository plus a checkout; adopted projects keep the original checkout in place.
- Selecting a repository subdirectory sets the agent's working directory. Git still
  operates on the whole repository. Bonsai does not initialize a nested repository.
- A child's checkout is allocated when it first runs, detached at its pinned base. A modifying
  run creates its branch and app-owned commit. Further modifying runs append commits;
  no-change conversations are valid.
- Children do not freeze their parent, and existing children never move to newer parent code.
  An adopted project's original checkout remains read-only.
- Runs stream conversation, tool output, questions and background activity. Stop cancels
  a run and preserves partial work; Resume, Keep and Discard are recovery actions.
  Finish now ends background waiting and saves remaining changes under the existing
  completion semantics. It is not proof that interrupted tests or jobs succeeded.
- Compact a conversation with `/compact [focus]` in the composer or Compact conversation in a
  card's ⋯ menu. The conversation shows "Compacting conversation…" while it runs and a divider
  afterwards, for automatic compaction too. Children branched later copy the compacted version.
- References are project-wide text written once — a test procedure, a result worth keeping —
  and given to any experiment by typing `@name` in a message (or the composer's @ button).
  Write one from References on the top bar, from Save as reference on a message, or from
  Create reference in a card's ⋯ menu, which can fill it from that experiment's conversation
  and `CONTEXT.md` with one tool-less model call. Nothing is saved until you save it. A run
  receives its references as read-only files and keeps the copy it read; the transcript marks
  a reference edited or deleted since and opens that exact copy.
- `@` also offers other experiments. Mentioning one gives the run a snapshot of its committed
  work to look up when needed: its conversation, its committed changes as a diff, and its
  `CONTEXT.md` notes. Nothing is pasted into the prompt; each read shows in the transcript, and
  the message's chip says when that experiment has changed since.
- Compare two to four experiments: pick them with Compare in the canvas controls, or
  ⌘/Ctrl/Shift-click cards. The Compare screen shows each experiment's goal, recorded testing,
  approach and changes as of a snapshot, and a conversation with an agent that has read each
  one's conversation, changes, notes and files. It only reads: it cannot run anything or change
  any experiment. When an experiment moves on, Update refreshes its snapshot. Answers can be
  saved as references, and comparisons are kept per project under Comparisons on the top bar.
- Review compares the experiment's inherited base with committed and unfinished work.
  Per-run diffs remain commit-specific. Oversized patches explicitly report truncation.
- Optional success criteria and check instructions go to the agent. Notes currently live
  in `CONTEXT.md` at the worktree root. Notes-only edits retain the existing special
  commit/revert behavior; moving notes into Bonsai records is separate planned work.

Historical plans are in [docs/v0-prd.md](docs/v0-prd.md) and
[docs/v0-decisions-and-backlog.md](docs/v0-decisions-and-backlog.md). They do not define
current scope or supersede implementation. Contributor instructions are in [AGENTS.md](AGENTS.md).

## Repository safety and permissions

Bonsai owns experiment branches, worktrees and commits. The agent is instructed to ask
for a new node instead of creating branches itself, and to provide instructions for
changes outside the experiment. Unexpected Git HEAD, branch or common-repository changes
stop app mutations and leave work available for inspection. Bonsai does not silently
reconcile an externally modified branch with its database.

**Worktrees are not security sandboxes.** Writable SDK tools and setup commands execute
with the host user's access. The Git command hook catches common commands; it does not
contain arbitrary shell programs or stop every way to alter Git. Use trusted projects
and commands. Scoped approval for external actions is planned, not implemented.

| Writable-run setting | Current adapter behavior |
| --- | --- |
| Ask before changes (`default`) | Requests that reach the permission callback are shown in Bonsai. SDK pre-approved operations need not ask. |
| Allow tools and commands (`acceptEdits`) | SDK accepts edits and Bonsai approves remaining tool requests, including shell commands. |
| Plan (SDK mode) (`plan`) | Passes SDK plan mode, but Bonsai approves ordinary requests that reach its callback. This is not an app-enforced read-only mode; setup may run. |
| Bypass permission checks (`bypassPermissions`) | Passes SDK bypass mode with its explicit dangerous-permissions opt-in. |

Read-only runs override those modes with a tool allow-list and deny other tools, including
Bash and agent delegation. They skip setup. These are SDK tool restrictions, not host
filesystem containment. Unit adapter tests pin the configuration; verifying a different
SDK version's actual behavior requires the opt-in live probes under `scripts/`.

Adoption refuses detached HEAD: select the intended branch with your own Git tools first.
Including uncommitted work snapshots tracked and eligible untracked files without changing
your index, checkout or refs; ignored files are excluded. A folder with no repository or
no commits is initialized/committed during adoption, which changes that folder.

Per-project copy-in files must be untracked in source and destination, ignored by the
**destination**, and free of symlink components inside the selected roots. Failed inspection
refuses the copy. A setup command runs before the first writable agent run. It is recorded
once even if the command fails; cancellation leaves it eligible to run again. Setup errors
appear in the conversation. A separate retry/versioned setup lifecycle is still planned.

Deleting an adopted project removes its app-owned worktrees and recorded branches while
preserving the original checkout and branch. Deleting a created project removes its owned
repository and checkout. Deletion refuses unexpected Git state; inspect and resolve drift
before retrying. It is not an archive operation.

To use a committed experiment outside Bonsai, use the command shown in node details.
For an adopted repository, create a **new** branch from the experiment in your original
checkout after saving its work, for example:

```bash
git switch -c my-result node/ACTUAL-NODE-ID
```

Replace the placeholder with the command Bonsai provides. Switching directly onto an
experiment branch fails while that branch is checked out in its Bonsai worktree.
This excludes unfinished work and does not apply, merge, publish or sync changes.

## Install and run

Requirements: **Node 22.18+**, npm, Git on PATH, and a supported Claude Agent SDK runtime.
CI uses current Node 22.x; stabilization is also checked with Node 24. Linux/macOS are
the supported process-cleanup targets. Detached-process discovery is not implemented on
Windows, and full process-tree cleanup must not be assumed there.

```bash
git clone https://github.com/MhmdAlTamimi/Bonsai.git
cd Bonsai
npm ci
npm start
```

`npm start` builds server and UI, serves on `127.0.0.1:8787`, and opens a browser.
The local API has origin/host checks, but no user authentication. Do not expose it through
a public proxy or treat loopback binding as a sandbox against local commands.

Connect through the app using a Claude subscription or an API key. Subscription sign-in
uses Claude's local authentication; API keys are stored in the local settings file with
restricted permissions and are not returned to the browser. Connection checks make a real
request. Real runs may incur usage charges; review the usage view and your provider's billing.
Saved projects and conversations remain reviewable without an active connection; actions
that require the agent are gated. Fake-agent mode is explicit and intended for development.

For development, use separate terminals:

```bash
npm run dev       # builds server once, then runs it; restart after backend edits
npm run dev:ui    # Vite UI, http://localhost:5173
```

`npm run build:ui` rebuilds the UI served directly by the backend. Vite changes are not
reflected in that built UI until rebuilt.

## Verification

```bash
npm test          # server build, typecheck, lint, format, server and UI/shared tests
npm run build:ui  # production bundle
npm run test:e2e  # builds both halves and runs real-browser scenarios
```

Browser tests require Chrome/Chromium. Set `BONSAI_CHROME=/absolute/path/to/chromium` if
it is not discovered automatically. They use a temporary data directory and fake agent;
no credentials or model calls are needed. Tests exercise real temporary Git repositories,
SDK adapter contracts, jobs, recovery, API and browser workflows. They do not prove live
SDK permission enforcement. The lockfile pins the reviewed dependency versions.

## Configuration and data

App and project settings cover models, effort, permissions, setup and locations.
Existing projects retain their recorded repository/worktree paths when defaults change.

| Variable | Default / purpose |
| --- | --- |
| `BONSAI_PORT` | `8787`, backend port |
| `BONSAI_DATA_DIR` | OS app-data directory for `bonsai.db` and `settings.json` |
| `BONSAI_REPOS_ROOT` | `<data dir>/repos`, default repository/worktree storage |
| `BONSAI_MODEL` | Optional default model |
| `BONSAI_FAKE_AGENT=1` | Explicit fake runner for development/testing |
| `BONSAI_CHROME` | Browser executable for the browser test harness |

The server prints its data location on startup. Use Settings to change preferences.
To reset only app preferences, stop Bonsai and back up/rename `settings.json` in that
location; this also removes the saved API key/default locations from the active settings.
It does not reset project settings stored in SQLite. Preserve the database, repositories
and recorded checkout locations. Deleting the whole data directory can destroy created
projects and experiment work; it is not a settings reset.

After a crash, unfinished runs become interrupted. Process cleanup is best-effort:
unmarked processes, abrupt host termination and unsupported platforms can leave work
running. Inspect external processes before resuming if necessary. Setup uses bounded
process-group cancellation on POSIX; observed marked processes are checked at run teardown,
and cleanup failures are recorded rather than described as successful stops.

## Layout

| Path | Responsibility |
| --- | --- |
| `packages/shared` | Shared API/data contracts |
| `packages/server/src/api` | HTTP endpoints and SSE |
| `packages/server/src/db` | SQLite storage and compatibility migrations |
| `packages/server/src/domain` | Lineage, permissions/flags and conflicts |
| `packages/server/src/git` | Git execution, snapshots, ownership, commits and review |
| `packages/server/src/agent` | Claude SDK adapter and fake runner |
| `packages/server/src/jobs` | Run scheduling, questions, cancellation and recovery |
| `packages/ui` | React canvas, conversations, review and settings |

Standing (pinned) references, running a procedure across compared experiments, multiple
code parents, Apply and broader SDK exposure belong to later phases. Stabilization does not introduce those features or migrate existing data.
