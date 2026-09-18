# UI/UX milestones

Source: [product audit](reports/bonsai-ui-ux-product-audit-2026-09-13.md).

## Review workflow

The side-panel baseline was committed and merged into local `main` before this work.
Each milestone starts from the previously reviewed and merged milestone, on its own branch.
Finish implementation and checks, then pause for the owner to run the app, explore, and request
changes. Merge and push only after that review. Do not start the next milestone before the checkpoint.

| Milestone | Branch | Findings | State |
| --- | --- | --- | --- |
| 1. Protect users’ work | `codex/milestone-1-protect-work` | F01–F05 | Accepted by owner; merged and pushed |
| 2. Simplify starting and branching | `codex/milestone-2-start-and-branch` | F06–F10, F13 | Accepted and merged/pushed; F10 resolved in milestone 6 |
| 3. Make results easy to judge | `codex/milestone-3-judge-results` | F11–F12, F14–F17 | Accepted by owner; merged and pushed |
| 4. Make ongoing work dependable | `codex/milestone-4-dependable-runs` | F18–F21, F25–F26 | Accepted by owner; merged and pushed |
| 5. Clarify controls and settings | `codex/milestone-5-controls-settings` | F22–F24, F27–F29 | Accepted; merged and pushed as `55332e8` |
| 6. Finish the visual experience | `codex/milestone-6-visual-experience` | F30–F38 | Accepted; merged locally as `4061c1f` |
| 7. Review changes clearly, and runs that end when the work ends | `codex/milestone-7-changes-and-runs` | Owner feedback, D43–D45 | Phase 1 implemented; ready for owner review |

## Milestone 1 review

Run `npm start` from the milestone branch. Drafts persist during this app session, including
switching projects or clearing selection; refreshing the browser clears them.

- Type different messages in two experiments, switch between them, and send one. The other draft stays put.
- Switch experiments while loading. Details and conversation show their own loading/error states, with Retry.
- Read testing notes in an experiment and its question-only child. Notes name their source node/run when
  committed provenance exists, flag inherited/older evidence, or explicitly say the source was not recorded.
- Open project creation. Browse folders without selecting one: creation stays disabled. Select a parent
  folder deliberately and review the full new-project destination. Existing-folder adoption requires a successful
  inspection of that exact selection. Invalid paths cannot silently reuse a previous inspection.
- Stop a writing run. Review partial changes above the transcript, including untracked files. Keep leaves a
  visible uncommitted-work notice. Discard names the experiment and files and requires confirmation.

Validation uses temporary projects and the fake agent, never personal projects or paid model calls.
The browser tests cover selection, delayed acknowledgments, failed loads, the existing canvas regression,
and cancellation/Keep/confirmed Discard. Backend tests cover inherited testing text and staged recovery.

Lifecycle freeze timing, offline-access policy, and checkout policy remain unchanged. Resolve the audit's
specific policy conflicts with the owner before a later milestone needs to alter those behaviors.


## Owner feedback incorporated in the plan

- **M2 — Checkout and names:** replace “Get this branch” with a collapsed “Use this code outside Bonsai” section.
  Explain where to run the command, the destination, and that it copies committed code without publishing or
  syncing. Hide it before an agent has produced a commit. Require an explicit experiment name in the creation
  dialog; allow Rename afterward for every experiment. This supersedes F13's automatic-name preference.
- **M3 — Panel reading:** make conversation and reviewing results distinct tasks. Keep a stable header and composer,
  offer direct Conversation/Changes navigation, and keep goals/checks together with attributed evidence. Durable
  technical details remain secondary. Avoid separate tabs for each small component.
- **M5 — Usage:** add a top-bar Usage entry showing project totals and experiment/run breakdowns. Remove repeated
  price labels from cards and the main bar. Distinguish recorded estimates, tokens, and scope; do not imply
  subscription estimates are extra bills or pretend to know account-wide usage.
- **M6 — Reading size:** raise the default reading size and add an app-wide text-size preference in Settings,
  persisted by the backend. Check enlarged text, narrow windows, and the panel layout together.
- **M4 — Branding (brought forward at owner request):** replace the existing mark with the supplied SVG and derive the favicon from the same artwork.
  The source is preserved in [design/bonsai-mark.svg](design/bonsai-mark.svg). It contains transparent vector
  paths and renders correctly; use a theme-aware treatment so the black artwork remains visible on dark surfaces.

## Milestone 2 review

- Creating a project selects its starting experiment. Its description appears in one editable composer with
  Start first run. No second Start form or early checkout command appears.
- Branch experiment stays directly under the panel header, including on frozen experiments.
- Creation asks for an explicit name and a request; code and conversation sources load from the server before
  submission. Source links close the dialog and select the corresponding experiment. Test a question-only
  parent to see the conversation and code sources diverge.
- Rename is in the experiment's More actions menu, including the root and frozen experiments. It updates only
  display metadata, not branch names, commits, or conversation.
- Use this code outside Bonsai is optional and collapsed. Read its instructions before copying a command.
- A failed initial start leaves the created experiment selected and its request ready to retry. This part of F26
  was brought forward from M4 because it is necessary for the unified first-run flow.

**F10 decision pending:** The existing backend freezes code edits when a direct child commits. AGENTS.md says
any child freezes its parent. The owner has been asked to choose; lifecycle behavior remains unchanged until
that decision. Broader offline-access and settings policy decisions remain in their later milestones.

Milestone 2 validation: `npm test` and all four browser integration scenarios pass. Browser tests use temporary
projects and the fake agent. Source previews reject stale code snapshots before creating a node.


## Milestone 3 review

Branch: `codex/milestone-3-judge-results`. Milestone 2 was merged and pushed before this branch started.
F10 remains an open policy decision; this milestone does not change freeze behavior.

- Open an experiment and switch between **Conversation** and **Results & changes**. Branch experiment stays
  reachable, and the composer retains the experiment's draft. Arrow keys, Home and End navigate the two tabs.
- Create an experiment: **Success looks like…** is visible and optional. Verification instructions remain
  optional. The creation action stays reachable in a scrolling dialog.
- Read Results: the latest run's outcome, goal, attributed testing notes, and missing evidence are stated
  separately. **Finished** means the run ended, not that it passed tests. Cancelled and failed runs are named.
- Inspect the first root run's **Changes from this run**. Then make several changes in one writable experiment
  and compare each run with **All changes in this experiment**. The aggregate uses the original code snapshot;
  a later question does not erase earlier changes.
- Use **Expand changes** for wider reading. File labels distinguish additions, deletions, renames and binary
  files. Text hunks show old/new line numbers. Uncommitted file names remain visible even with an empty patch.
- A failed diff load says it failed and offers Retry. A failed Copy patch action gives visible feedback.

Technical validation: `npm test` passes, including real-Git root/multi-run comparisons, untracked-only work,
file operations, quoted names, line numbers and repeated +/- content. All five browser scenarios pass using
isolated temporary projects and the fake agent; the results scenario also exercises failed fetches, clipboard
failure, aggregate changes after three modifying runs plus a question, and the expanded viewer.


## Milestone 4 review

Branch: `codex/milestone-4-dependable-runs`. Milestone 3 was merged and pushed before this branch started.

- **Reading:** scroll up during a run, select text, switch experiments, and return. Each conversation keeps its
  position for this app session. **Jump to latest** resumes following output. Refreshes keep loaded history;
  failed updates label it as previously loaded and offer Retry. Individual run replies can be collapsed.
- **Activity:** live tool calls stay in expandable chronological groups, preserving the reader's choice when
  persisted history replaces streamed output. Agent activity and queued position remain visible by the composer.
  Replies now render tables, nested lists and task lists; code blocks have Copy with success/failure feedback.
- **Connection:** the top bar distinguishes local-server stream health from the agent model/credential. A transport
  gap shows Reconnecting and keeps the last state visible. Reconnect reloads the tree, details and conversation;
  it never submits a run. Initial connection/project failures offer Retry; old project responses cannot replace
  a newly selected project. Stale node/history reads are aborted and read requests time out visibly.
- **Stop:** cards and the panel cover working, queued and permission-waiting jobs. Their shared **Stopping…** state
  lasts until server state confirms completion; a failure is shown beside the control. Stop all includes queued
  and permission-waiting jobs, with affected experiments in its tooltip.
- **Permission:** the active request replaces the ordinary composer. Its action and target are visible; recorded
  input is expandable. Refusal text belongs to that question, and an answer from another window gets a specific
  already-answered response. New permission inputs are stored in schema 11; old records retain their original text.
- **Top bar and creation:** the supplied SVG is now the app mark and favicon. The project name is the project-menu
  control; model, local-server health and Settings have distinct places. Test it at laptop widths. Creation shows
  compact Conversation/Code source rows with timing/snapshot badges and optional details. Success criteria remain
  visible and the optional testing instructions remain collapsed, as confirmed by the owner.

Usage consolidation stays in milestone 5; app-wide text sizing and the remaining visual work stay in milestone 6.
F10 freeze timing and F24 offline-auth policy are unchanged. A browser transport outage preserves already-open
history; this does not change initial credential gating. Creation/start-failure recovery from milestone 2 remains
covered by the browser suite.


Validation: `npm test` passes (142 backend tests and 67 UI/shared tests), along with type checking, lint and
format checks. All eight browser scenarios pass using temporary projects and the fake agent. These exercise
reading restoration, failed history updates, missed events, Chromium offline/online reconnection, permission
answers across windows, queued cancellation, Stop failures, startup Retry, and the narrow top bar. The final
permission-card corrections were rechecked separately. No new dependencies were added.

Restart the running app with `npm start` before reviewing so the backend and the built interface both use this
milestone. Merge and push this branch after the owner's review.


## Milestone 5 review

Branch: `codex/milestone-5-controls-settings`. Milestone 4 was accepted, merged and pushed as `af8c1fc`.
The owner approved keeping saved history accessible when credentials expire or the agent is rate-limited.
The experiment-folder button remains deferred at the owner's request. Text-size controls remain in milestone 6.

- **Settings:** open the gear, then switch between **App settings**, **Project settings**, and **Diagnostics**.
  Each editable group has an explicit Save and local Saving/Saved/error feedback. Close and reopen to verify
  persistence. A failed save keeps the entered values and does not claim success. Project changes are atomic;
  a failed app settings write leaves the prior file and effective values intact.
- **Scope:** App defaults seed future projects. Existing projects can explicitly follow the app's model/effort
  defaults. Project agent settings apply when the next run begins, including queued work; an active agent keeps
  its configuration. Expand **Next run** by the composer or in creation to inspect the server-resolved model,
  effort and permissions with their source. No new experiment-specific overrides were added.
- **Setup:** new projects start with no extra files to copy. Creation previews configured setup, and setup
  messages are grouped under **Experiment setup** with a link to project settings. Deliberately listed missing
  files still produce an actionable warning. Existing projects retain their saved lists: remove an unwanted
  `.env` entry in Project settings once; legacy automatic and deliberate entries cannot be distinguished safely.
- **Usage:** open **Usage** in the top bar for this project's recorded estimates, tokens and experiment/run
  breakdowns. Price labels no longer repeat on cards, in the bar, or in conversation footers. Estimates are
  explicitly API-equivalent, not account balances or subscription bills. Missing historical model/source data
  is marked as unrecorded; active run usage appears when recorded.
- **Agent access:** saved experiments remain reviewable with an unavailable agent. A persistent notice leads to
  connection settings. Send, Resume and Create and run require reconnecting; reconnecting never sends a draft.
  Authentication/rate failures reported during runs update the gate for subsequent starts. Login instructions
  appear before the action. No automatic fake-agent fallback was added.
- **Deletion:** confirmations name the project or experiment, describe deleted and retained disk content, and
  list affected experiment names for subtrees. Project deletion still requires its name. Native modal focus
  containment is used for these dialogs, with **Cancel** focused by default.
- **Diagnostics:** Generate report shows the exact JSON before Copy report can write the clipboard. Reports omit
  experiment names, connection/run error text and free-form log content; known credential strings and common key
  patterns are redacted from remaining metadata. Local paths and run metadata remain visible for review.
  Gathering errors and clipboard errors are separate; a copy failure keeps the report available.
- **Folders:** managed repositories, app data, and the project's main folder have distinct labels. Folder-opening
  failures are reported. Checkout remains a secondary disclosure; Copied belongs to the exact current command.

Validation: `npm test` passes, including type checking, lint, formatting, backend and UI/shared tests.
All nine browser scenarios pass. The new scenario covers failed/successful scoped saves, exact diagnostics
preview/copy and clipboard failure, Usage, credential expiry/reconnect with draft preservation, destructive
focus containment and cancellation, and future repository locations with existing deletion paths preserved.
Tests use temporary projects and the fake agent; no real credentials, personal projects or paid calls.
No new dependencies. Schema 12 pins each project’s storage path; existing files are not moved. F10's previously deferred freeze-timing decision is unchanged.

Restart with `npm start`, review these flows, then request any edits before this branch is merged and pushed.


## Milestone 6 review

Branch: `codex/milestone-6-visual-experience`. Milestone 5 was accepted, merged and pushed as `55332e8`.
The owner's project-tab folder button is sufficient; no experiment-folder action was added.

**F10 resolved, superseding the earlier pending notes:** a direct child freezes its parent's code only
when it commits. Question/clarification children do not freeze it. Deleting the last committed direct
child restores writability; another committed child keeps it frozen. An adopted original folder stays
read-only. AGENTS.md and decisions D4/D24 now agree with this owner-approved behavior.

**D41, new and owner-approved:** a folder inside a repository can be opened, the way an editor opens
one. The nearest enclosing repository is the project; the folder chosen is the agent's working
directory inside every experiment's worktree. Git still sees the whole repository.

### Structure and system health, before the visual work

- **The store no longer grows without a boundary.** `db/store.ts` was one class of fifty methods over
  five tables; it is now one module per concern (projects, nodes, runs, messages, checks) with a views
  module assembling what the interface reads, behind a `Store` facade that kept every call site
  unchanged. A test fails if a concern-sized store reaches into another.
- **The one real memory leak is closed.** Live run output was kept whole, for every experiment, for the
  life of the project view. It is a view of a run in flight, not the record of it, so the buffer is
  bounded and unpersisted setup chunks merge instead of each costing a re-render.
- **Eight requests per run were carrying no new state.** The credential was re-read on every stream
  event; it is re-read when a run reports a failure, which is the only thing that changes it. Two N+1
  reads went with it. Measured before and after — see the health review.

### What to look at

- **Reading and settings (F30–F31):** one type scale of eight steps, and nothing sets a size outside it.
  Primary reading is 14.5px, secondary 13px, code 13.5px — a monospace face reads smaller than the sans
  beside it. Settings → App settings → Appearance saves Standard / Large / Larger (100%, 115%, 130%);
  cards, dialogs and controls are sized in rem so they grow with it rather than clipping. Contrast
  measurements are in the health report and re-recorded by the browser suite on every run.
- **Dialogs and keyboard (F32, F38):** creation, Rename, settings, deletion and expanded changes share
  native modal focus containment and restoration. Backdrop clicks keep forms open. Enter submits;
  Shift+Enter adds a request line. IME composition does not trigger submission or folder navigation.
  Experiment actions support arrow keys, Home/End and Escape. A focused map experiment opens with Enter/Space.
- **Map (F33–F35):** visible plus handles accompany the ordinary Branch experiment button. **Canvas
  hints** replaces the map key: one trigger toggles it, a click away or Escape closes it, and nothing
  inside repeats the trigger's job. Status uses SVG shapes plus labels; selected conversation ancestry is
  highlighted and edge labels name experiments. Background additions keep zoom; selection reveals a node
  with minimal pan. **Selecting an experiment no longer pins it** — a click was starting and ending a
  drag, which wrote a position and froze that card out of the automatic layout.
- **Canvas controls (F33/F35):** zoom out, the zoom level, zoom in, Fit canvas, Canvas hints and any
  Automatic position are one family — one height, radius, border, icon weight, pressed and focus state,
  with a tooltip on each. React Flow's own controls, which had their own sizes and their own corner, are
  gone. Pressing the zoom level resets it to 100%.
- **Window composition (F36):** wide windows show the map and the experiment together and the panel can
  be collapsed — and stays collapsed until it is asked back. Narrow windows show one at a time, chosen
  with a segmented two-state switch; the wide window gets a single button instead, because a switch whose
  only state is the state you are in does nothing. Switching keeps the canvas viewport, the reading
  position and any draft. Short zoomed windows use one scrolling panel.
- **Repository and working folder (D41):** creating a project from an existing folder names the
  repository and the working folder as two separate facts. A subfolder of a repository is accepted and
  the repository keeps its branch and history; a folder in no repository is still initialised as one,
  where it is; nested repositories resolve to the nearest enclosing one. The project menu can reveal
  either folder.
- **Questions from the agent (D42, owner-approved):** when the agent asks you something, the run waits in
  **Needs you** in every permission mode, read-only experiments included. The question box shows each question
  with its options, descriptions and any preview, and always offers **Other** with a text box. Answer, choose
  **Let the agent decide** (it chooses and says what it chose), or Stop. There is no timeout, and the question
  survives a reload. What was asked, the options, and your answer are in the conversation. This replaces a trap:
  under `acceptEdits` the question used to vanish and the agent wrote "I'll wait" into a run that had ended.
- **Read-only experiments are read-only (D18 corrected):** frozen experiments and an adopted project's own folder
  could change files under `acceptEdits`, because the tool list only pre-approved. Two real runs on your adopted
  `research` project had run Bash in your own folder (only `find`/`grep`; the folder is clean). Enforcement now
  denies everything but reading and asking.
- **Identity (F37):** the owner-supplied mark and matching favicon from milestone 4 are retained. Every
  glyph now comes from the one local SVG family — the typographic close, more, chevron, arrow and home
  characters are gone, so nothing borrows its weight from the font. No icon dependency.

Review at 1280×720, a narrow window, and enlarged text. Try branch creation with keyboard only; switching
Map/Experiment with a draft and a half-read conversation; collapsing the panel and clicking around the
map; dragging a card and then Automatic position; starting a run whose request makes the agent ask you
something, then answering, typing your own answer, and letting the agent decide; opening a subfolder of one of your own repositories and
checking where the agent starts; and deleting a committed child to restore its parent's writability.
Restart with `npm start` so backend and interface match.

System-health findings, fixes, measured limits and verification are recorded in
[the milestone 6 health review](reports/milestone-6-health-review-2026-09-15.md).
No dependencies were added. Merge and push only after the owner's review.

## Milestone 7 review

Branch: `codex/milestone-7-changes-and-runs`, from local `main` after milestone 6 was merged as `4061c1f`.
Nothing is pushed. The owner reviews each phase before the next one starts.

| Phase | What | State |
| --- | --- | --- |
| 1. Runs end when the work ends | D43, D45: waiting for background work, Finish now, leftover processes, end reasons, recovery by cause | Reviewed and accepted |
| 2. Changes tab and floating diff windows (D44) | Conversation · Changes · Summary tabs, a file tree, in-app diff windows | **Withdrawn.** Not approved; reverted in full, D44 struck from the log |

The owner then supplied a design — an HTML reference and a README — for the panel, the review of a node's
changes, and the canvas. It replaces phase 2 and is being built in steps, each reviewable on its own:

| Step | What | State |
| --- | --- | --- |
| 1. Revert phase 2 | The tabs, the diff windows and the change API they needed | Done |
| 2. Tool results | What each command printed and each edit changed, captured from the SDK, so RUN and EDIT blocks are real | Implemented |
| 3. Conversation panel | The design's `5a`: identity, meta line, You/Agent messages, run dividers, tool blocks, composer, collapsed rail | Implemented |
| 4. Review screen | The design's `5c`/`9a`: file tree, diff panes, split, grips, conversation docked at 285 | Implemented |
| 5. Canvas | The design's `5b`/`6a`: top bar, node cards with the Review control, elbow edges, one control cluster | Implemented |
| 6. Docs | D46 and this checklist | Implemented |

### Phase 1 — what to look at

- **A long command reads as work.** Above the composer, a running experiment says what it is doing and for how
  long — `Running uv sync · 1m 12s` — instead of "Agent working…". Setup commands show the same way.
- **A run waits for its background work (D43).** When the agent's turn ends with a background job still running,
  the experiment stays **Running**; the card and the header say **Waiting**, and the panel lists each job with how
  long it has run. The run ends — and commits — when the work does, however long that is. A process started with
  `nohup … &` is found too, marked **detached**, and the agent is told when it exits.
- **Finish now** ends the wait: it stops the jobs and ends the run normally, so what is there is committed.
  **Stop** still cancels, and nothing the run started keeps running afterwards; the conversation says what was
  stopped.
- **Recovery says what happened (D45).** "You stopped this run." / "The run failed." (with the error) /
  "Bonsai closed while this run was working." / "Files changed after this run finished." The buttons are
  **Continue from these files**, **Leave uncommitted** and **Discard…** — or **Run it again** / **Dismiss** when
  nothing was written, and **Ask the agent to review them** after a finished run. The agent receives the same
  story: a finished run is never described to it as interrupted. Card chips say **Stopped** or **Failed**
  rather than "Cancelled".
- **Switching never stops a run.** Selecting another experiment, opening another project, leaving the page or
  reloading all leave a run going; a browser test now checks all four.

Try: rerun the chunking experiment that exposed this. `uv sync` and the batch run should keep it Running/Waiting
until the work truly finishes, then commit the outputs in that run. Also start something long and press Finish now;
start something and press Stop, and check the notice reads "You stopped this run". Without a credential, the stand-in agent
(`BONSAI_FAKE_AGENT=1 BONSAI_FAKE_BACKGROUND_MS=60000 npm start`) reaches these states from requests starting
`background:` (a tracked job) or `detach:` (a nohup-style process). Restart with `npm start` so backend and interface match.

Verified against the real SDK with `scripts/probe-agent-runs.mjs` (paid, opt-in): a tracked job keeps the run open
and wakes the agent; Finish now ends it in seconds; Stop leaves no process; a job detached inside a script is found,
waited for, and reported to the agent. No dependencies were added.

### The design rebuild (D46) — what to look at

- **The panel is the conversation, and nothing else.** No tabs. The header is the experiment: a status dot, its
  name, how many runs, and one line saying what it inherited and what it changed — `from master · 183 files
  +17,604`. Runs are the unit below it: a divider names each one, your message is an object you can see, the
  agent's reply is text on the panel, and the run's footer is its time, cost and model.
- **A tool call shows its work.** A command is a **RUN** block with what it printed and its exit code; an edit is
  an **EDIT** block with the file and its changed lines, green and red, numbered. Everything else — reading,
  searching — folds into one dim line (`Read ×6 · Grep ×2`), because a run makes forty of those and none of them
  is the story. Output is capped, so a 10,000-line log cannot take over the panel.
- **Checks, lineage, details and Use outside Bonsai are still there**, folded under the conversation as *Result
  details*, so nothing was lost with the tabs.
- **Review is a screen, not a tab.** Open it from a card's **Review +N →** or its ⋯ menu, or by pressing ⏎ on a
  focused card. A file tree on the left with status letters and per-file counts; the diff beside it; **Split**
  shows two files at once, with the focused pane marked; `/` jumps to the filter, Esc goes back to the map, which
  kept its place. The conversation stays docked at the right edge and collapses to a rail with **⌘\**.
- **The canvas carries what you steer by.** A card is its name, a status dot, its description, the state as a
  word, and the change summary as the way into review. Nothing to review means no control at all, so the card
  tells you whether there is anything to look at. Its ⋯ menu holds Review, Branch child, Rename, Delete — and
  **Stop this run** while it is running, which is where the card's Stop button went.
- **The top bar is three things**: the mark, the project menu and settings. The agent's model, the server-health
  dot and the Usage button are gone from it — Usage is in the project menu, and a broken stream says so as a
  notice rather than sitting there saying "live" all day.
- **Master's card counts its change.** It used to say "no file changes" however much it had written, because
  master pins no base; it now measures from the commit before its first modifying run, which is what review
  already showed.
- **Contrast.** The design's dimmest steps are below 4.5:1 where they carry text, so the ink ramp is lifted for
  those steps and left alone for gutters and separators. Say if you would rather have the design's exact values.

Try it at 1280×720, in a narrow window and with enlarged text: read a run with a long command in it; open review
on an experiment with several files, split two files, drag the tree wider, collapse the conversation with ⌘\ and
bring it back; stop a running experiment from its card menu; rename from the card; and check that a
question-only experiment says "no file changes" while master says what it wrote. Without a credential,
`BONSAI_FAKE_AGENT=1 npm start` reaches all of it. Restart with `npm start` so backend and interface match.
