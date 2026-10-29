# Audit phase 9 — live updates

2026-10-03, `main` at 5842b8c. How the page stays current: the event stream,
what each event makes the page do, reconnecting, several tabs, and, per the
plan, the contract between server and page.

Files: `api/events.ts`, `api/routes/events.ts`, `shared/src/contract.ts`
(`ServerEvent`), `ui/api/client.ts` (`subscribe`),
`ui/state/useRunStream.ts`, `ui/panel/chat/useChat.ts`,
`ui/panel/chat/liveMerge.ts`.

## How it works

Each open page keeps one stream (Server-Sent Events) for its project. The
server sends eleven kinds of event: run started, text, activity, question,
finished and error; node status; "the tree changed"; references and
comparisons changed; and a hello. A keep-alive goes out every 25 s, and a
page more than 1 MB behind is dropped rather than buffered.

Nothing is replayed. When the stream comes back, the page fetches everything
again. Text from a run is shown as it arrives and merged with the saved copy
by run and sequence number. Every other event is a signal to fetch again:
the tree, the open conversation, the connection, references or comparisons.

## Findings

### L1 · High · verified — Six tabs freeze Bonsai in every tab

Each page holds its stream open for as long as it is open. Bonsai's server
speaks HTTP/1.1, and over HTTP/1.1 a browser allows six connections to one
host, shared by all its tabs.

`tabs.mjs` opened tabs one at a time and timed an ordinary request from the
newest and from the first:

| Tabs open | Newest tab | First tab |
| --- | --- | --- |
| 2 to 5 | 3 ms | 4 ms |
| 6 | no answer after 8 s | no answer after 8 s |
| 7 | no answer after 8 s | no answer after 8 s |

At six, the streams hold every connection, so every request in every tab
waits. Nothing says why: buttons do nothing and lists stop loading. Every
experiment has its own address, so opening a few side by side is natural, and
a tab forgotten in another window counts too.

Reproduce: `node scripts/audit/tabs.mjs` (needs `npm run build`).

**Fix (S–M).**

- Now: close the stream when a tab is hidden, and reconnect and refetch when
  it is shown again (`visibilitychange`). Only visible tabs then hold one,
  and hidden tabs stop doing work they cannot show.
- Later: share one stream between all tabs, with one tab holding it and
  passing events on through a `BroadcastChannel`.

### L2 · Medium · verified — Every change anywhere in the project downloads the open conversation again, in full

`useChat.ts:60-81` fetches the whole conversation, from its first message,
whenever the project's revision counter changes. That counter moves on
"tree changed", node status and run finished, from *every* experiment in the
project.

`refetch.mjs` opened a 150-run conversation (321 KB), then ran ten runs on
*other* experiments. The open conversation was downloaded **20 times, 6.3
MB**, and each time it was parsed and the transcript drawn again. The map was
fetched 12 times. The cost grows with the conversation's length times the
project's activity: with three runs going and a long conversation open, that
is megabytes a minute and repeated work on the page's main thread.

The messages endpoint already accepts `afterSeq`, which returns only what is
new, but the page always asks from 0.

Reproduce: `node scripts/audit/refetch.mjs` (needs `npm run build`).

**Fix (S).** Refetch the conversation only for events about the open
experiment, and then only what follows the last message the page has.

## The contract between server and page

Server and page share their types (`@bonsai/shared`), so within one build
they cannot disagree. The eleven event kinds the page listens for
(`client.ts:405-417`) match the eleven the server sends today. Two gaps
remain:

- **Version skew.** A tab left open across an upgrade keeps running the old
  page against the new server. This is phase 1's S3. The fitting runtime
  check is small: put the build's id in the `hello` event, and have the page
  reload, or ask to, when it differs.
- **Drift.** The listened-for list is typed by hand. Build it from a
  `Record<ServerEvent['type'], true>` object, and end the page's event
  `switch` with an exhaustive check, so adding an event kind to the contract
  without listening for it and handling it fails to compile.

Validating every payload at runtime would add little beyond that, because
the remaining risk is skew, and the build id catches skew directly.

## What is solid

- **Reconnecting resyncs.** When the stream reopens, the page clears stale
  activity and fetches the tree, connection, references and comparisons, so
  missed events cannot leave it wrong for long.
- **A slow page cannot grow the server's memory**: it is dropped past 1 MB.
  Keep-alives stop idle streams being cut.
- **Activity goes out at most once a second per run**, with the latest state
  always sent last.
- **Live text and saved text do not double up**: they are merged by run and
  sequence number.
- **Two tabs, one question**: the second answer is told the question was
  already answered.

## Learning note — invalidation versus data

An event can carry data ("here is the new message") or only say *something
changed, look again*. Bonsai uses the second, which is the simpler and more
robust choice: a missed event costs at most one refetch, never a wrong
screen. Its price is what each "look again" fetches. L2 is that price paid in
full, and the cure is to keep the design and scope the refetch: this
experiment only, and only what is new.

L1 is the classic catch with streams over HTTP/1.1. HTTP/2 carries many
streams over one connection, which is why it does not have this problem.
Serving HTTP/2 locally needs TLS, though, so sharing or closing streams is
the practical fix.

## Fix first

L1: it stops the app outright, in every tab, with no message. Then L2, which
is a small change in one hook.
