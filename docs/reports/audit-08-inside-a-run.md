# Audit phase 8 — inside a run

2026-10-03, `main` at 5842b8c. What happens while the agent works: which
tools it may use and who approves them, questions it puts to you, background
work it leaves running, the guard on git commands, and what is recorded in
the conversation. Tested with the stand-in agent, and with the real Claude
Code against `fake-api.mjs` (phase 7).

Files: `agent/ClaudeSdkRunner.ts` (`permissionOptions`, `toolResultEvents`),
`agent/toolResults.ts`, `agent/guards.ts`, `jobs/questions.ts`,
`jobs/background.ts`, `jobs/leftovers.ts`, `jobs/runTranscript.ts`,
`jobs/runNode.ts`.

## How it works

- **Tools.** Writable runs approve tools through a callback. Under the
  default mode ("Allow tools and commands") everything is approved. Under
  "Ask before changes", requests reach you as questions. Read-only runs are
  limited to reading tools by the same callback.
- **Questions.** A permission request, or a question the agent asks you, parks
  the run as *needs you* until you answer, leave it to the agent, or stop it.
  There is no time limit.
- **Background work.** Commands the agent starts in Claude Code's background
  mode, and processes it detaches itself (found by an environment marker every
  agent process carries), keep the run *waiting* until they end or you press
  Finish now.
- **The git guard.** A hook refuses Bash commands that look like `git commit`,
  `git checkout` and other verbs that change git. After the run, Bonsai checks
  the folder is still where it recorded it, ends leftover processes, then
  commits.
- **The record.** Every message, tool call and result is saved and streamed.
  A command keeps the last 40 lines of its output, each cut at 400 characters.

## Findings

### I1 · High · verified — A tool that commits by itself leaves the experiment stuck, and its tag lands in your repository

`npm version patch` is an ordinary thing to run in a JavaScript project, and
it makes a commit and a tag. Run by the real Claude Code in a project added
from a folder (`agent-commits.mjs`):

- the run ended *interrupted*: "This experiment's Git state changed outside
  Bonsai";
- Discard was refused (HTTP 409), and so was the next run;
- **tag `v1.0.1` was now in your own repository**, because worktrees share
  their repository's tags.

The guard (`guards.ts`) looks for `git <verb>` in the command text. Anything
that runs git for you gets past it: `npm version`, release tools, a Makefile
target, a script, `sh -c '…'`. The guard is honest about this in its comment,
and says a commit that slips through "is detected and folded back". What
actually happens is that the run fails and the experiment is stuck, the same
dead end as phase 5's R1 and phase 6's B3.

Reproduce: `node scripts/audit/agent-commits.mjs`.

**Fix (M).**

- Do what the comment says. When, after a run, the folder's position has
  moved only by new commits on top of the recorded one, fold them into the
  run: move the position back without touching the files, and commit
  everything as the run's commit. This is the same reconciliation as R1's.
- List tags and branches created during the run ("The agent created tag
  v1.0.1 in your repository") and offer to remove them.

### I2 · Medium · verified — A command that fails shows no output in the conversation

With the real Claude Code, a command that succeeded showed its output, while a
command that failed (`echo visible-fail >&2; exit 3`) showed only the
command line: no output, and no sign that it failed. The npm failure above
looked the same, though its output said exactly what was wrong ("Author
identity unknown").

Bonsai builds the output block from the SDK's structured `stdout` and
`stderr` fields (`toolResults.ts:37-46`). For a failed command those fields
were not there, so no block was made; a failed edit takes the same path.

Failed commands are when the output matters most: tests, builds, installs.
The conversation's own design keeps "the END of its output, because that is
where it says how it went".

**Fix (S).** When there are no structured fields, or the result is marked as
an error, build the block from the result's text (its last 40 lines), marked
as failed.

### I3 · Medium · verified — Runs waiting on you, or on background work, hold run slots; a new request queues with no reason given

`held-slots.mjs` uses the default of three runs at once. Two experiments
asked a question and one left a dev server running. A fourth experiment's
request then showed "Queued · position 1" for as long as nobody answered, and
there is no time limit on questions.

The limit exists to bound how much agent work goes on at once. A run parked
on your answer does none, and there is no way to tell from the queued run why
it is not starting.

Reproduce: `node scripts/audit/held-slots.mjs`.

**Fix (S–M).**

- Do not count runs parked on a question against the limit, since their agent
  is idle.
- Say why a run waits: "Waiting for a free slot: 2 runs are waiting for your
  answer", linking to them.

### I4 · Medium · by reading — On Windows, processes the agent leaves running are neither found nor stopped

`leftovers.ts:36-49` reads `/proc` on Linux and asks `ps` on macOS. On
Windows it returns nothing; the README says so. A dev server or file watcher
the agent detaches keeps running after the run, keeps its port, and keeps its
files open. On Windows that also means the experiment's folder cannot be
deleted or archived, which leads into phase 5's R2.

**Fix (M).** On Windows, list processes with their command lines and parent
ids (`Get-CimInstance Win32_Process`), match those started from the
experiment's folder, and end the agent's process tree with `taskkill /T` when
a run ends. This can be checked in the Windows CI job.

## What is solid

- **Recorded output is bounded**: 40 lines of 400 characters per command, so
  a run that prints megabytes does not grow the database.
- **Questions are handled carefully.** A second answer from another window is
  refused with a clear message, Stop releases a parked run, and an answer must
  match the kind of question.
- **Read-only runs are enforced** by the permission callback, not only by a
  list of tools.
- **Background work is visible and stoppable** on Linux and macOS: tracked
  jobs and detached processes are shown as *waiting* and ended by Stop or
  Finish now.
- **The guard catches the direct cases** and says plainly what it does not
  catch.

## Handed to later phases

- What the agent can do on your machine under the default mode, secrets in
  transcripts, and prompt injection → phase 15.
- Compaction and how the conversation reads → phase 11.

## Fix first

I1, together with R1's reconciliation: one mechanism ends all three "stuck
after changed outside Bonsai" dead ends. I2 is small and visible every day.
Then I3, then I4 with the Windows CI job.
