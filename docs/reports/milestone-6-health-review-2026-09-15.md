# Milestone 6 — system health review

Branch `codex/milestone-6-visual-experience`, 15 September 2026.

Scope: module boundaries, async state ownership, race conditions, storage and
query patterns, subscriptions, error handling, tests, dependencies, and runtime
and memory behaviour. Written before the remaining milestone 6 interface work so
that work lands on a structure worth adding to.

Measurements come from two scripts in `scripts/`, runnable on any machine:
`measure-tree.mjs` (store reads, synthetic in-memory data) and
`measure-requests.mjs` (one real run, real browser, stand-in agent).

---

## 1. Architecture and module boundaries

**Was:** `db/store.ts` was one class of fifty methods over five tables —
projects, nodes, runs, messages and questions all edited the same file. There
was no line for a change to be on the wrong side of, so every feature made it
longer. It was the largest non-test file on the server and the one most likely
to be touched by unrelated work.

**Now:** one module per concern — `projectStore`, `nodeStore`, `runStore`,
`messageStore`, `checkStore` — with `views.ts` assembling the read models and
`rows.ts` holding the shapes and the pure parsers. `Store` remains as a facade
with the same method names, so no call site changed.

The rule is a test, not a comment: `db/boundaries.test.ts` fails if a
concern-sized store imports anything from `db/` other than `rows.ts`. `views.ts`
is the named exception, because reading across the concerns is what building a
tree is.

**Boundaries that were already right and were left alone:**

- The UI reaches the server only through `api/client.ts`; the lint config
  forbids `node:*` and `**/server/**` imports from `packages/ui`, so PRD §9
  constraint 5 is enforced by the module graph rather than by discipline.
- `git/exec.ts` is the only module that shells out to git, and it never builds a
  command string.
- The freeze rule is derived in `domain/flags.ts` and the base-commit walk in
  `domain/lineage.ts`; neither is reimplemented anywhere, including in the UI.

**Accepted, not fixed:** `api/router.ts` is 900 lines of route handlers. It is
long but flat — each route is independent, and validation sits next to the route
it guards. Splitting it by resource is a reasonable later change and is not
urgent, because nothing in it is shared mutable state.

## 2. Async state ownership and races

Checked every place where two things can arrive out of order.

| Flow | Guard | Verdict |
| --- | --- | --- |
| Project tree refetch | `request` ticket + `current` project ref, both checked before every `setState` | correct; a slow response for project A cannot overwrite project B |
| Node detail / messages | `AbortController` per effect plus an `alive` flag | correct |
| Answering a question twice | `UPDATE … WHERE answered_at IS NULL` — one statement, not read-then-write | correct; a second window gets an explicit 409 |
| Run cancel vs. run finish | `settled` flag inside the waiter, abort listener removed on settle | correct |
| Delete vs. run in flight | `withStoppedNodes` marks retiring, cancels, then waits with a 10s deadline | correct; failure is a 409, not a half-deleted tree |
| Create/delete in one project | `ProjectOperations` serialises structural git per project | correct |
| Draft ownership | keyed by `[projectId, nodeId, channel]` in a session map | correct |

**Fixed here:** the app re-read the credential *and the whole settings object*
on every stream revision — every status change and every finished run. It was
two extra HTTP requests per event and, worse, replaced both objects on arrival,
re-rendering everything that reads them for no new information. The connection
gate only changes when a run reports a failure, so the reload now hangs off a
separate `agentRevision` that only `run.error` (and recovering from a transport
gap) bumps.

Measured on one stand-in run: **13 requests, down from 21** — the four
refetch-triggering events each cost two requests that carried no new state.
The saving scales with event count, so a tree with several agents running is
where it matters.

## 3. Storage and query patterns

`treeView` issues a constant number of queries whatever the tree's size, which
was already true and is now visible in one place (`views.ts`). Measured:

| Nodes | median | p95 |
| --- | --- | --- |
| 5 | 0.08 ms | 0.17 ms |
| 100 | 0.47 ms | 0.62 ms |
| 500 | 2.16 ms | 2.85 ms |

Linear and far below the 120 ms refetch debounce, so the tree read is not a
scaling risk at any size this product will see.

**Two N+1 patterns found and removed:**

- `findFolderOwner` listed every project's nodes, one project at a time, on
  every folder inspection — and the picker inspects while you type. Now one
  query for all worktrees. At 50 projects × 21 nodes: 1.28 ms median.
- Deletion impact summed `nodeCost` per doomed descendant — a query per node
  every time a confirmation dialog opened. Now one grouped query
  (`RunStore.costOfMany`).

**Accepted:** the panel refetches the whole transcript (`afterSeq=0`) on each
revision — five times during the measured run. `afterSeq` exists, but the
reconciliation in `liveMerge.ts` is written against a complete message list, and
making it incremental would trade a real correctness property (a duplicate or
out-of-order frame is identifiable) for a saving that is invisible at any
transcript length a node actually reaches. Revisit if a node ever holds
thousands of messages.

## 4. Subscriptions, listeners and timers

- **SSE, server side:** one `Set` of responses per project; `res.on('close')`
  unsubscribes; the keep-alive interval is cleared there and is `unref`'d so it
  cannot hold the process open. A response with more than 1 MB buffered is
  destroyed rather than allowed to grow. No leak.
- **SSE, client side:** one `EventSource` per project, opened in an effect keyed
  on `projectId` alone — deliberately, since a dependency on the refetch
  callback would tear the stream down several times a second during a run. The
  four `window` listeners it adds (`pagehide`, `pageshow`, `offline`, `online`)
  are all removed by the returned unsubscribe. No duplicate subscriptions:
  StrictMode's double-invoke mounts, unmounts and remounts, and the unmount
  closes the first stream.
- **React effects:** every timer in `useConnection`, `useLaidOutNodes` and
  `useProjectTree` is cleared on cleanup; the `ResizeObserver` in
  `useReadingPosition` is disconnected. Menus add their `mousedown`/`keydown`
  listeners only while open.
- **Child processes:** `runCommand` clears its timeout, removes its abort
  listener, and escalates SIGTERM → SIGKILL after 5 s. `git()` runs with a 120 s
  timeout and a bounded buffer.

## 5. Memory

**Fixed — the one real leak.** Live run output was kept whole, for every node,
for the life of the project view. Nothing ever dropped a frame, so an agent
working for an hour accumulated thousands of deltas and a session spanning
several runs held all of them. Live output is a *view* of a run in flight, not
the record of it — the record is in the database and the transcript re-reads it
— so the buffer is now bounded (`state/deltaBuffer.ts`, 400 frames per node,
oldest dropped first).

The same change fixes a related CPU problem: setup output arrives as many small
unpersisted chunks, and `npm install` on a cold cache emits hundreds. Each one
was its own array entry, its own state update and its own re-render, at the one
moment the canvas can least afford them. Consecutive unpersisted text from the
same run now grows the entry already there. Tool frames are never merged,
because they carry structure the transcript renders separately.
`deltaBuffer.test.ts` covers the bound, the merge, and that what survives the
bound still reconciles correctly against the transcript.

**Bounded and accepted:** the session maps for drafts (`chat/drafts.ts`) and
reading positions (`chat/useReadingPosition.ts`) grow by one small entry per
node visited and are never pruned. A session would have to visit tens of
thousands of nodes for this to matter, and pruning them would lose exactly the
state they exist to keep.

**Server:** the log keeps one file per day and prunes to fourteen; command output
is tail-truncated at 64 KB per stream; `tools_offered` is written once and read
whole. Nothing accumulates in memory across runs — `RunJobs` deletes from
`running` in a `finally`, and the queue is drained on shutdown.

**Idle:** with no run in flight the client makes no polling requests at all (the
measured run shows requests only in response to events), and the server's only
periodic work is one 25-second SSE keep-alive per open stream.

## 6. Error handling

Consistent, and the important part — *not claiming success* — holds throughout:

- A failed run is recorded as `failed` with its error and leaves the worktree
  dirty for recovery; an aborted run is decided from the signal, not from the
  runner's message, so no runner can mislabel a stop as a failure.
- `sendError` maps `OperationConflict` → 409 and `HttpError` → its status;
  everything else is a 500 with the message, logged with the route *pattern* so
  ids do not accumulate as unique strings.
- The UI distinguishes "failed to load" from "showing previously loaded" in the
  transcript, the tree and the details, and every one of those offers Retry.
- `describeError` never leaks the shape of a JavaScript error to the user, and
  is tested for it.

**Accepted:** mutating requests have no client-side timeout, unlike reads.
That is deliberate — adopting a large repository or running a setup command can
legitimately take minutes, and aborting a request that has already had an effect
is worse than waiting. Reads time out at 20 s and say so.

## 7. Tests

158 backend tests, 73 UI/shared tests, 10 browser scenarios; type checking, lint
and format checks all run in `npm test`. Coverage is strongest exactly where the
domain is subtle: the base-commit walk, freeze derivation, real-git diff and
recovery cases, cancellation, permission answers across windows, and the canvas
staying visible across a refetch (the bug that only a browser can see).

Added in this pass: the store boundary test, and the delta buffer tests.

**Gap worth naming:** there is no test that a long-running agent's memory stays
bounded — the new buffer is unit-tested, but nothing asserts end to end that a
noisy run does not degrade the canvas. That needs a load-shaped test the project
does not otherwise have, and it is not worth building for V0.

## 8. Dependencies

Four runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `react`,
`react-dom`, `reactflow`, plus `@dagrejs/dagre` for layout. `npm audit` reports
zero vulnerabilities. Nothing was added in this pass, and nothing here is a
candidate for removal: each is load-bearing and none has a plausible smaller
substitute at this size.

---

## 9. Found while finishing the interface

Two defects the structural work surfaced, both fixed and both now covered by the
browser suite:

- **A click was pinning cards.** React Flow's `nodeDragThreshold` defaults to 0,
  so a plain mousedown/mouseup on a card started and ended a drag, fired
  `onNodeDragStop` and wrote a position — silently freezing every experiment
  anyone selected out of the automatic layout, and offering "Automatic position"
  for a node nobody had dragged. Four pixels of slop. The new browser assertion
  fails against the old behaviour, which was checked rather than assumed.
- **A CSS specificity collision hid the canvas controls.** `.app.panel-hidden >
  .view-switch` outranked the narrow-window rules, so on a narrow window with
  the panel closed the floating button covered the control bar instead of
  sitting in the top bar. The floating rule is scoped to a min-width query now.

One more was found and left alone deliberately: the stylesheet has accumulated a
per-milestone appended block since milestone 3, each overriding rules defined
earlier in the file. Type is no longer part of that problem — every size is a
token now, defined once — but several structural rules are still declared twice.
Merging them is mechanical and safe, and it is churn in a file the owner is
about to review by eye, so it belongs at the start of the next piece of work
rather than at the end of this one.

## Summary of changes made

| Change | Why |
| --- | --- |
| `db/store.ts` split into five concern stores + views, behind a facade | prevent the god object from absorbing milestone 6 |
| `db/boundaries.test.ts` | keep the split from rotting |
| Bounded, coalescing live delta buffer | the one real memory leak, and a re-render storm during setup |
| Credential re-read moved to `agentRevision` | 8 of 21 requests per run carried no new state |
| `findFolderOwner` in one query | N+1 on every keystroke in the folder picker |
| `RunStore.costOfMany` | N+1 on every deletion confirmation |
| `scripts/measure-requests.mjs`, extended `measure-tree.mjs` | so these claims can be re-checked rather than believed |
| `nodeDragThreshold={4}` | a click was pinning every card it landed on |
| One dismiss rule for menus and popovers | three copies, and a copy is how one loses its Escape half |
| One type scale; one icon family | fourteen type sizes and five glyphs from the font |
