# Audit phase 14 — sign-in and settings

2026-10-03, `main` at 5842b8c. Connecting Bonsai to Claude — a subscription
through Claude Code, or an API key — the connection screen and its checks,
and the Settings dialog: app settings, project settings and diagnostics.
Looked at in Chromium; the connection check was driven with the real Claude
Code against `fake-api.mjs` (phase 7). Diagnostics' content and how the key is
stored are phase 15's.

Files: `api/connectionGate.ts`, `agent/connection.ts`,
`api/routes/system.ts`, `settings.ts`, `panel/ConnectionScreen.tsx`,
`panel/SettingsDialog.tsx`, `panel/AgentFields.tsx`,
`state/useConnection.ts`.

## How it works

Bonsai checks the connection at startup and on *Recheck*: first, for free,
`claude auth status` when no API key is stored; then one small model call,
because "signed in" is not the same as "still works". Until the check
passes, no project can be created and nothing can run, but saved
experiments stay readable. *Sign in with Claude* runs `claude auth login
--claudeai`; an API key is stored in Bonsai's settings file, readable only by
you.

Settings has three tabs — App, Project, Diagnostics — and seven sections,
each with its own *Save* and its own saved/failed feedback. Each setting says
when it applies (new projects, the next run, scheduling across projects).

## Findings

### N1 · Medium · verified — A wrong or revoked API key is reported as a timeout, "or offline"

With a key the API rejects (401), the connection screen said:

> The connection check failed. The connection check timed out. Claude Code
> may be starting up, or offline.

It never says the key was rejected. Claude Code retries a 401 (phase 7, A2:
eleven times over three minutes); the check gives up at 45 s
(`connection.ts`, `probeConnection`) and reports the timeout. Sixteen requests
reached the API during that one check. A person who pasted a key with a typo,
or whose key was revoked, waits most of a minute and is then told to check
their network.

The message also runs out of its card: it is set in a non-wrapping block and
overflows the right edge at 1280 px.

**Fix (S).** The check already reads the SDK's messages: stop at the first
`api_retry` whose status is 401 or 403 and say "The API rejected this key —
check it, or create a new one", and at a 429 say it is rate-limited rather
than waiting it out. Let the message wrap. Phase 7's A2 is the same change
for runs.

### N2 · Medium · by reading, checked against the bundled Claude Code — Signing in with a subscription needs a second, separately installed Claude Code

Bonsai's agent is the Claude Code its SDK bundles. Signing in, though, runs
`claude` from your PATH (`connectionGate.ts:182`), and so does the free
status check (`connectionGate.ts:133`). Without a separate global install,
the screen says "The Claude Code CLI is not installed, and no API key is
stored", and *Sign in* says "The `claude` command is not on PATH. Install the
Claude Code CLI, or use an API key instead."

The bundled copy has the same `auth login`, `status` and `logout` commands
(checked). The PATH copy can also be a different version from the one that
runs the agent, so the two can disagree about a credential.

**Fix (S).** Run `auth status` and `auth login` with the bundled binary —
resolved the way `bundledClaudeCodeVersion` already finds the SDK package —
and use the PATH `claude` only if that fails. The instruction "run `claude
auth login --claudeai` in a terminal" then names the bundled binary's path
when there is no global one.

### N3 · Low · verified — Edits in Settings are dropped without a word when it closes

Changing *Concurrent runs* and closing the dialog without pressing *Save app
defaults* discarded the change, with no warning; reopening showed the old
value. With seven *Save* buttons over three tabs — appearance, agent
defaults, storage and location on one tab — it is easy to change two things,
save one, and lose the other.

**Fix (S).** Mark a section with unsaved changes ("Not saved"), and when the
dialog closes with any, ask whether to save them. Settings that take effect
at once and are easy to undo — text size — can simply save on change.

## What is solid

- **Saved history stays readable** when the agent is unavailable, and
  nothing that would spend money starts without a working connection.
- **The two ways in are explained** on the first screen: a subscription,
  where Bonsai never sees the credential, or a key, stored on this machine
  only, readable just by you — and where Bonsai keeps its data.
- **Settings say when they apply** — new projects, the next run (queued
  runs included), scheduling across all projects — and *Next run* by the
  composer shows the effective model, effort and permissions with where each
  comes from.
- **Saving is safe**: the settings file is written to a temporary file and
  renamed, so a crash cannot leave it half-written; a failed save keeps what
  you entered and says so (covered by the browser test suite).
- **The connection check is cheap first**: the free status check settles the
  common case before any model call is made.

## Handed to later phases

- The default permission mode — *Allow tools and commands*, which approves
  shell commands — and how the API key is stored and shown in diagnostics →
  phase 15.

## Fix first

N1, with phase 7's A2: one change to read retries, and a rejected key stops
being a minute-long mystery. N2 removes a separate install from the first
five minutes. N3 is small.
