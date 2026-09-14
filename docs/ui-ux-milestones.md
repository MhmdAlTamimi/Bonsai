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
| 2. Simplify starting and branching | `codex/milestone-2-start-and-branch` | F06–F10, F13 | Accepted and merged/pushed; F10 decision remains deferred |
| 3. Make results easy to judge | `codex/milestone-3-judge-results` | F11–F12, F14–F17 | Accepted by owner; merged and pushed |
| 4. Make ongoing work dependable | `codex/milestone-4-dependable-runs` | F18–F21, F25–F26 | Ready for owner review |
| 5. Clarify controls and settings | `codex/milestone-5-controls-settings` | F22–F24, F27–F29 | Pending |
| 6. Finish the visual experience | `codex/milestone-6-visual-experience` | F30–F38 | Pending |

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
