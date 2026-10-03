# Audit phase 11 — the conversation panel

2026-10-03, `main` at 5842b8c. The panel beside the map: the thread of runs,
live output, the composer and its drafts, questions from the agent, recovery,
and how the panel copes with long conversations. Looked at in Chromium on
the phase 10 fixture, in every experiment state, at 1280×720, 1280×900 and
1440×900.

Files: `panel/Panel.tsx`, `panel/chat/Transcript.tsx`, `chat/Composer.tsx`,
`chat/useChat.ts`, `chat/drafts.ts`, `chat/useReadingPosition.ts`,
`chat/Markdown.tsx`, `chat/markdown.ts`, `node/AskBox.tsx`,
`node/Recovery.tsx`, `chat/ActivityStrip.tsx`, `styles/panel.css`,
`styles/markdown.css`.

## How it works

The panel is the selected experiment's conversation, as runs: your message,
then what the agent did (folded into one line that names the files, opening
to a block per step) and what it said, then the run's time and cost. Below the
thread sit, as they apply: recovery after an interrupted run, the activity
strip while a run works or waits, the question box when the agent asks, and
the composer. Drafts are kept per experiment while the page is open. The
thread follows new output unless you have scrolled up, and offers *Jump to
latest*.

## Findings

### C1 · Medium · verified — An unsent message is lost when the page reloads

Drafts live in a JavaScript map (`drafts.ts:1-2`), and nothing in the
interface uses browser storage. Typed a request into an experiment's
composer, reloaded: the composer held the experiment's original description
again, and the request was gone. The same happens on closing the tab, a
browser crash, or the computer restarting — and attachments go with it.

Requests to an agent are often long and carefully worded, and reloading is
what Bonsai's other failures ask for: a stale tab after an upgrade (phase 1,
S3) and the six-tab freeze (phase 9, L1) are both cured by reloading. The
earlier decision to keep drafts "for this app session" predates both.

**Fix (S).** Keep each experiment's draft and attachments in `localStorage`
under the same project/experiment key, written as you type (debounced) and
cleared when the message is sent — the per-viewer convenience browser storage
is for.

### C2 · Medium · verified — A long conversation slows the whole page, whatever else is happening

The thread draws every message of every run, and it is fetched and drawn
again in full whenever anything in the project changes (phase 9, L2).
`long-thread.mjs` opened one experiment and changed *another*:

| Runs in the open conversation | Elements on the page | Main-thread time per change elsewhere |
| --- | --- | --- |
| 50 | 1,832 | 85 ms |
| 200 | 6,782 | 255 ms |
| 500 | 16,681 | 487 ms |

Each run sends several such changes, so with a long-lived experiment open and
others running, the page stalls for a quarter to half a second at a time —
typing in the composer lags. A conversation of a few hundred runs is a few
weeks of use of one experiment.

Reproduce: `node scripts/audit/long-thread.mjs` (needs `npm run build`).

**Fix (M).**

- L2's fix first: refetch only for events about this experiment, and only
  what is new.
- Keep each finished run's messages as a stable array, and memoise `Turn`,
  so a refetch redraws only the run that changed.
- Draw the latest runs, with *Show 480 earlier runs* above them, or
  virtualise the thread.

### C3 · Medium · verified — When the agent asks you something, the answer buttons are below the fold

The bottom of the panel — recovery, activity, the question box, the composer —
is capped at 48% of the panel's height and scrolls inside itself
(`panel.css:347`). A question with one choice of two options:

- at 1280×720, *Send answer* was 100 px below the window (y = 821);
- at 1440×900 it was cut in half at the bottom edge;
- meanwhile the thread above kept a large empty area.

This is the moment the agent is stopped until you act (and holds a run slot —
phase 8, I3). The agent may ask up to four questions at once, each with
options.

**Fix (S).** While a question is waiting, give the question box the space:
lift the cap, let the thread shrink, and keep the action row (*Let the agent
decide*, *Send answer*) pinned at the bottom.

### C4 · Low · verified — A queued request is not shown in its own panel

An experiment whose run is waiting for a slot shows "Queued · position 1" and
an empty thread: the request you sent is nowhere on screen until the run
starts. This is the interface side of phase 7's A3 (the request is saved only
when the run starts), and A3's fix — save the request when it is sent — fixes
it too.

### C5 · Low · verified — Result tables break their words apart at the panel's default width

`.markdown` sets `overflow-wrap: anywhere` (`markdown.css:7`), table cells
inherit it, and the table is `width: 100%`. In the 380 px panel a six-column
comparison came out as "Appr oach", "laten cy", "Me mor y", "instan ce",
although its wrapper can scroll sideways. Comparison tables — benchmarks,
options — are a common way for an agent to report.

**Fix (S).** `overflow-wrap: normal` on table cells, and
`width: max-content; min-width: 100%` on the table, so a wide table scrolls
in its wrapper instead.

## What is solid

- **Untrusted text stays text.** The agent's replies are rendered as React
  elements, never HTML, and only `http(s)` and `mailto` links survive —
  `javascript:` and `data:` are refused.
- **Recovery says what happened and what each choice does**: "You stopped
  this run", the background job that was stopped, the files not yet saved, and
  *Continue from these files*, *Leave uncommitted*, *Discard changes*.
- **Waiting is explained**: the background job, how long it has run, what
  ending it does, and *Finish now*.
- **Questions are first-class**: options with descriptions, *Other* with a
  text box, *Let the agent decide*, and the question and answer recorded in
  the thread.
- **The thread reads as a conversation**: work folds into one line naming the
  files, long requests clamp to six lines, code blocks scroll, failed loads
  have Retry, and drafts survive switching between experiments.
- **The composer is careful**: Enter does not send mid-IME composition, the
  next run's model, effort and permissions are one click away with where each
  comes from, and sending is refused, with the reason, when the agent is
  unavailable.

## Worth considering

**Steering a run.** While a run works, the composer only takes the next
message for later; to correct an agent going the wrong way, the choice is to
wait or Stop. The run's input is already a stream that stays open between
turns (`agent/session.ts`, `Inbox`), and Claude Code accepts messages
mid-session, so sending a message into a running run is mostly a matter of
the interface and recording it in the thread.

## Fix first

C3 and C5 are small and land at decisive moments. C1 is small and protects
the user's own work. C2 follows L2 (phase 9) and is what keeps the panel
usable as experiments grow old.
