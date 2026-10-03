# Audit phase 7 — a run, start to finish

2026-10-03, `main` at 5842b8c. A run from the moment you send a message to
the moment it is recorded as finished, stopped or failed. Per the plan, this
covers the queue and the limit on runs at once, the connection gate, what the
API's failures do (a revoked key, rate limits, overload, no credit, no
answer), and spending.

Files: `jobs/runNode.ts`, `jobs/runTranscript.ts`, `agent/ClaudeSdkRunner.ts`,
`agent/connection.ts`, `api/connectionGate.ts`, `api/routes/runs.ts`,
`api/routes/system.ts`, `db/runStore.ts`, `db/messageStore.ts`,
`ui/state/useConnection.ts`, `ui/panel/UsageDialog.tsx`.

## How it was tested

The stand-in agent replaces the Agent SDK completely, so it cannot show what
the SDK does. This phase added `scripts/audit/fake-api.mjs`, a local stand-in
for Anthropic's Messages API. Bonsai runs the real Claude Code bundled with
its SDK, pointed at the stand-in, which answers from a script: a tool call, a
reply, or a 401, 429, 529, billing error or silence on cue. Nothing is spent.

## How it works

Sending a message creates the run and marks the experiment running. If the
limit on runs at once (default 3, between 1 and 10) is reached, the run waits
in a queue. When it starts, the request is saved to the conversation, the
folder is prepared, and the agent resumes the experiment's own Claude Code
session. Everything the agent does is recorded as it happens. At the end, a
finished run is committed. A run you stop is recorded as stopped. A run that
fails leaves the experiment interrupted, with its partial work kept for
Recovery.

A connection check (one small query) gates every run. Failures that look like
a bad credential or a rate limit mark the connection, and new runs are
refused (HTTP 428) until it is checked again.

## Findings

### A1 · High · verified — Each run's cost includes every earlier run of its experiment, so Usage is overstated, and more so the more you use it

The cost and token figures the SDK reports for a resumed session do not
start at zero. They continue from the totals saved in the session file. The
SDK documents this ("a resumed or forked session continues from the total its
transcript saved … so the first result already carries the earlier turns"),
and Claude Code writes a `cost-state` entry with the running total at the end
of each run.

Bonsai resumes the experiment's session for every run
(`runNode.ts:631`), stores the reported total as that run's cost
(`runTranscript.ts:152-157`), and Usage adds up the runs
(`runStore.ts:138-175`).

Tested with `api-failures.mjs cost`: three identical runs of one experiment
were recorded as **$0.0075, $0.0135 and $0.0195**, with 2,000, 3,000 and 4,000
input tokens. Their real costs were about $0.0075, $0.006 and $0.006. The
carry-over was also seen once against the real API: a session already
holding $1.50 reported $1.65 for a call of about $0.15.

After *n* equal runs the recorded total is about *n(n+1)/2* runs' worth: 5.5
times too high after 10 runs, and 10.5 times after 20. A child's
conversation is a copy of its parent's session, so by the same documentation
its first run also carries the parent's total (not measured here).

Usage is the only spending information Bonsai gives, and it is the basis any
spending limit (A4) would need.

Reproduce: `node scripts/audit/api-failures.mjs cost`.

**Fix (S–M).**

- Keep the last total each experiment's session reported, and record a run's
  cost as the new total minus that.
- A child starts from its parent's stored total at the moment of the copy.
- Add the fake-API case as a test: identical runs must cost the same.

### A2 · Medium · verified — While Claude Code retries a failing API, Bonsai just shows "working"; a rejected key takes three minutes to fail, and one rate limit stops every experiment until you re-check

The SDK reports each retry as an `api_retry` message, with the attempt, the
delay and the HTTP status. Bonsai ignores it: `ClaudeSdkRunner.ts:245-290`
handles `init`, background jobs, thinking, compaction status and the compact
boundary, and nothing else.

Tested with `api-failures.mjs`:

| The API answers | Requests | Time to fail | What the interface could show |
| --- | --- | --- | --- |
| 401 (wrong or revoked key) | 11 | 178 s | "working" |
| 429 (rate limit) | 11 | 175 s | "working" |
| 529 (overloaded) | 3 | 4 s | "working" |
| 400 (credit balance too low) | 1 | 1 s | — |

Each run then fails cleanly: interrupted, nothing committed, and the error in
the conversation.

After a 401 or 429, the connection is marked and every new run, on every
experiment, is refused. Nothing checks again by itself: `GET /api/connection`
returns the stored state, and only "Check again", signing in or changing the
key re-checks. The screen meanwhile says "Bonsai will work again once that
clears". So a per-minute rate limit hit by one experiment stops all of them
until you click.

A billing failure is not recognised (`connectionGate.ts:44-53`), so the
connection stays "connected" and each new run fails the same way.

Reproduce: `node scripts/audit/api-failures.mjs key rate overloaded billing`.

**Fix (S–M).**

- Show retries as the run's activity, for example "The API is rate-limiting:
  retry 3 of 10 in 20 s".
- For a 401 with an API key, stop the run at the first retry rather than
  waiting out ten.
- After a rate limit, re-check by itself once the wait the API gave has
  passed.
- Recognise billing errors.

### A3 · Medium · verified — A request waiting in the queue is lost when Bonsai closes, and after a crash Resume sends the previous request instead

A queued request lives only in memory. Its text is saved to the conversation
when the run starts (`runNode.ts:590`).

`queued-close.mjs` allows one run at a time and leaves experiment B's second
request waiting behind A:

- **Closed properly**: B's waiting request is gone. B shows as ready, and its
  conversation has no trace of the request.
- **Crash**: B is interrupted, and Resume sends the agent *B's first request*
  ("Please start again from the beginning: first request for B"). Resume takes
  the last request saved in the conversation (`messageStore.ts:83`), which is
  the previous one.

Reproduce: `node scripts/audit/queued-close.mjs`.

**Fix (S).**

- Save the request and its attachments with the run when it is created.
- On close, keep a queued run as "not started", with *Send again*.
- Have Resume use the run's own request.

### A4 · Medium · by reading — No spending limit, and a run's cost is unknown until it ends

- There is no limit per run, experiment, project or day. Up to 10 runs can go
  at once, and a run can last hours while background work goes on. The SDK
  offers `maxBudgetUsd`, which counts only the spend since that call started,
  and `maxTurns`. Neither is used.
- While a run goes, its cost is not shown: Usage says "Pending". The cost is
  written only when the run ends.
- A crash loses it. Runs marked "app closed" at startup keep a cost of 0
  (`runStore.ts:279-293`), so money that was spent never appears in Usage.

**Fix (M, after A1).**

- A per-run budget in Settings, passed as `maxBudgetUsd`. The SDK ends the
  turn with `error_max_budget_usd`; say "stopped at your $5 limit".
- Optionally, a daily budget per project that refuses new runs, with a clear
  message.
- Publish the running cost with the run's activity, since every turn's result
  carries it, and save it as it arrives.

## What is solid

- **Stop works even when the API hangs.** It took effect in 2.2 s, with
  nothing committed.
- **API failures end cleanly.** The experiment is interrupted, nothing is
  committed, partial work is kept for Recovery, and the error is in the
  conversation. A 401 or 429 marks the connection, so new runs are not
  started against a dead credential.
- **One run per experiment, and an honest queue.** The limit applies, raising
  it starts waiting runs at once, and a queued run can be stopped.
- **A stop is always a stop.** An aborted run is recorded as stopped, never
  as failed, whatever the runner said on its way out.
- **Cost is read from the right field** (`modelUsage`, not `usage`), and
  subscription users are told it is an API-equivalent figure.

## Learning note — fake the wire, not the library

The stand-in agent replaces the SDK, so it behaves the way Bonsai *expects*
the SDK to behave, and A1 and A2 are exactly the places where that
expectation is wrong. A fake at the network boundary keeps the real Claude
Code in the loop: its retries, its cost bookkeeping and its error wording.
This is the "don't mock what you don't own" rule. `fake-api.mjs` is small
enough to become a test fixture, with A1's identical-cost test and A2's retry
cases as its first tests.

## Handed to later phases

- Two runs at once in one repository: phase 4 (18 of 18 committed). Two Bonsai
  processes: phase 1 (S1). Two tabs: phase 9.
- What the agent may do on your machine, and secrets in transcripts → phase 15.

## Fix first

A1: the only spending figure Bonsai shows is wrong, and wrong by more every
day. Then A3, which is small, then A2, then A4, which builds on A1.
