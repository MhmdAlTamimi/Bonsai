# Bonsai — UI/UX product audit

**Review date:** 13 September 2026  
**Primary baseline:** `claude/side-panel-rework`, commit `d68d373`  
**Comparison baseline:** `main`, commit `3ba6630`  
**Purpose:** A product brief and prioritized implementation backlog for improving the existing alpha.

## 1. Product verdict

Bonsai has a useful core: explore several approaches without losing the code or conversation that produced each one. The interface already makes the existence of those experiments visible. It does not yet make their meaning, trustworthiness, and next actions equally clear.

**The next design pass should make Bonsai a dependable experiment workspace.** A person should be able to answer, at any moment:

1. Which experiment am I working in?
2. What code and conversation does it start from?
3. Is the agent working, waiting for me, finished, or interrupted?
4. What changed, and what was actually checked?
5. Should I continue here, ask a question, or branch a new experiment?

Today those answers are distributed across small badges, tooltips, a long panel, raw commands, and implementation terminology. Some answers are actively misleading: a draft follows selection to another node; inherited testing notes can appear to belong to the selected experiment; and the folder picker selects the home directory before the user has chosen a project.

A theme refresh alone would make these problems look more finished. Fix information ownership and workflow first, then improve visual comfort and identity.

### Recommendation on the side-panel branch

**Keep its direction; do not accept it wholesale as the finished UX.** The current checkout is three commits ahead of main, not one. The changes include parsing utilities, lineage data, and the panel rework.

Preserve the run-based transcript, grouped tool calls, file-based diffs, shared child-creation dialog, resizable panel, fixed composer, and deletion overflow menu. These are meaningful improvements over main. Correct the remaining action duplication, cross-node state, hidden recovery controls, and missing aggregate review surface before calling the rework complete.

The original main panel is not a better destination: it has a flatter transcript, a less comfortable scrolling arrangement, and a second child-creation form. If this branch is discarded, carry its useful product decisions into the replacement rather than reintroducing those problems.

## 2. Evidence, coverage, and limits

This is an expert review grounded in a running build and source inspection, not a usability study with representative users. Priorities are judgments about task impact and risk, not measured abandonment rates.

The app built successfully. Browser review used a separate local instance with an isolated temporary data directory and the explicitly enabled stand-in agent. No real model calls were made. The user's projects, branches, credentials, and preferences were not used as test fixtures. The report does not assess the quality of Claude's real responses, login completion, billing accuracy, or model availability.

### What was reviewed

| Surface | Coverage | Evidence and limitation |
| --- | --- | --- |
| Connection screen | Source | All connection states and login/key actions inspected; real authentication not exercised. |
| New project tab | Browser + source | Empty state, folder browsing, project creation, and first node selection. |
| Existing folder tab | Browser + source | Default selection, repository inspection, already-managed folder state; no personal folder adopted. |
| Project menu | Browser + source | New/existing entry points, Recent, reveal actions, deletion entry. |
| Canvas and cards | Browser + source | Five-node demo topology, selected/writable/frozen/conversation-only states, status labels, layout, zoom controls. Dragging and lowest zoom levels additionally reviewed in source. |
| New experiment dialog | Browser + source | Prompt, derived name, rename-before-create, optional success/check fields, creation and automatic start. |
| Node panel | Browser + source | New, running, completed, frozen, exploration, divergent lineage, and interrupted states. |
| Transcript and tools | Browser + source | Multiple runs, grouped tools, live output, completion and cancellation. Rich real-agent output reviewed through renderer source. |
| Changes | Browser + source | Successful child-run diff and silent failure opening first root-run diff. |
| Checks and details | Browser + source | Current and inherited testing notes, expandable metadata, context record. |
| Permission request | Source | Allow/refuse flow, refusal text, pending question identity, busy-state handling. Not exercised with real tool requests. |
| Recovery | Browser + source | Started and stopped a test run; inspected Resume/Discard/Keep. Destructive discard not executed. |
| Deletion | Source | Node/project impact messaging, modal behavior, cascading consequences. Deletion not executed. |
| Settings | Browser + source | Connection, Agent, Locations, project setup and Diagnostics; keyboard focus probe. Values not changed through the UI. |
| Narrow windows | Browser + source | 1280×720 baseline, 800×720 and 480×720; temporary viewport override reset. |
| Failures and reconnect | Browser + source | A local-server interruption exposed stale connection status and misleading empty conversation; additional failure paths inspected in source. |
| Visual system and identity | Browser + source | Type, spacing, surfaces, colors, icons, logo implementation, favicon, motion and focus. |

There are no conversation/result/settings tabs in the current panel. Its sections and disclosures were reviewed as they actually exist. The only current tab pair is New project / Use an existing folder. Proposed navigation below is a recommendation, not a description of existing functionality.

### Evidence convention

**B** means reproduced or directly observed in the browser. **S** means confirmed from the implementation. **J** means a design judgment to validate with users. Each finding includes the relevant component or module. Paths are relative to the project root; the source map in section 11 provides links.

### Scope and unresolved product rules

The supplied project rules are the implementation guardrail. The repository contains later functionality and documentation that conflict with portions of them. Reviewing existing surfaces does not authorize expanding their scope.

| Decision | Conflict | Instruction for a future implementation agent |
| --- | --- | --- |
| Freeze timing | Project rules say a node freezes when it gets a child. `domain/flags.ts` freezes it when a direct child commits. UI copy alternates between leaf language and “a child committed.” | Obtain an explicit decision before changing lifecycle behavior. Render server flags meanwhile; do not infer writability from children in UI code. |
| Existing folders | Project rules defer importing existing repos; D36 and the existing UI support adopting a directory in place. | Audit and repair the existing flow only if retained by the owner. Do not add import or turn existing branches into nodes. |
| Getting code out | Rules say generated branch names are never shown; the checkout component exposes them inside commands. D36 describes using those commands. | Decide whether the existing technical escape hatch is an exception. Do not build export, merge, sync, or checkout execution into this UI pass. |
| Offline access | README and `App.tsx` require a connection before showing the app. Local historical review need not technically require a model. | Treat read-only offline access as a proposed policy change requiring a decision, not an incidental styling fix. |
| Settings scope | UI says model/effort/mode apply to new projects. README says next run; decision log discusses project defaults. | Verify and document effective precedence before offering new controls. Per-node model selection stays deferred. |

## 3. Priority and implementation order

**P0 — fix before inviting another person to rely on the alpha:** wrong destination, misleading evidence, unintended filesystem target, or an irreversible action whose consequences are obscured.  
**P1 — fix in the next UX iteration:** blocks or materially confuses the core experiment workflow.  
**P2 — improve after the workflow is coherent:** readability, orientation, consistency and polish.  
**Decision required:** no implementation until the owner resolves the specific ambiguity.

| Order | Work package | Findings | Outcome |
| --- | --- | --- | --- |
| 1 | Protect context and work | F01–F05 | Drafts, evidence, folder targets and partial work have clear ownership. |
| 2 | Make the core journey explicit | F06–F13 | One way to start, clear branching consequences, honest run states, clear evaluation. |
| 3 | Make inspection dependable | F14–F21 | Readable history, useful diffs, dependable loading, navigation and errors. |
| 4 | Make settings and exceptional states coherent | F22–F29 | Predictable settings scope, permissions, cancellation, deletion and diagnostics. |
| 5 | Establish the visual and accessible system | F30–F38 | Comfortable reading, discoverable controls, usable modals, coherent identity and window behavior. |

Do not implement this table as five giant commits. Group a small number of related findings into reviewable changes, preserve the demo script, and ask before adding dependencies.

## 4. Findings: correctness and trust

### F01 — A draft belongs to a node, not to the panel

**P0 · B/S · `Panel.tsx`, `chat/useChat.ts`, `chat/Composer.tsx`**

A draft typed into “Use argparse for subcommands” appeared in master's composer after selecting master and opening “Ask a question.” The panel intentionally survives node changes, but its single `prompt` state survives with it. This prevents one kind of draft loss by creating a more serious ambiguity: Send now targets a different node.

**Replace:** panel-owned draft state with drafts keyed by project and node. Preserve an in-session draft when selecting elsewhere, restore it only to its owner, and clear only the submitted owner's draft after success. Ensure a slow response to A cannot clear a newly typed draft for B. Keep drafts editable while another run is active; sending may remain unavailable.

**Acceptance:** Type distinct drafts in A and B; switch repeatedly; each remains attached to its node. Send A, switch to B before acknowledgment, and verify B is unchanged. Persistent drafts, if chosen later, use the backend rather than browser storage.

### F02 — Previously selected data can remain under the new node's heading

**P0 · S · `Panel.tsx`, `chat/useChat.ts`, `node/StartRun.tsx`**

Node detail and message state are not cleared or identity-checked when selection changes. Requests have an alive guard, which helps prevent late responses from taking over, but previously loaded content remains while the new request is pending. If that request fails, the previous node's details or transcript can remain under the new heading. `StartRun` also initializes its local prompt only on mount.

**Replace:** unqualified state with identity-tagged loaded data and explicit loading/error states. Only display content when its node ID matches selection. Scope StartRun drafts to the node as well. Keep the tree server-owned; a loading placeholder is presentation state, not optimistic domain state.

**Acceptance:** With delayed and failed detail/message requests, switch A→B→C. No prior-node transcript, checks, checkout command or initial prompt may appear as C's content. Show Retry beside the failed section.

### F03 — “Did it work?” can show somebody else's testing evidence

**P0 · B/S · `node/Checks.tsx`, server `api/router.ts`, `git/context.ts`**

The question-only child displayed its parent's testing text under “Did it work?” despite having no check criteria of its own and making no commit. The detail endpoint reads `CONTEXT.md` from the current worktree and extracts its Testing section; that file can be inherited. A heading about the selected experiment therefore makes stronger claims than the evidence supports.

**Replace:** anonymous testing text with provenance: which node/run produced it, whether it is inherited, and whether it predates the latest changes. If provenance is unknown, label it “Existing testing notes — source not recorded.” Do not parse prose into pass/fail. An unchanged inherited file is not proof that the current run verified anything.

**Acceptance:** A checked parent, a question-only child, and a later code-changing child never share an unlabeled result. Old notes cannot be presented as checks for a newer run. “No checks recorded for this run” remains a valid state.

### F04 — Merely opening a folder browser chooses the home directory

**P0 · B/S · `DirectoryPicker.tsx`, `NewProject.tsx`**

The picker calls `onChange` after its initial browse. On New project it silently replaces the claimed data-directory default with the home directory. On Existing folder, the screen immediately offered “Use this folder” for the home directory and described initializing it as a repository. The user had not chosen a project folder.

This is exactly where an extra deliberate selection step is valuable. The code comment argues that browsing should equal choosing; that shortcut is unsuitable when the current location becomes the target of initialization or adoption.

**Replace:** separate “folder being browsed” from “selected project folder.” New project should show a compact location summary with Change. Existing folder should require an explicit selected target and completed inspection. Show the resolved destination including the new subfolder before submission. Keep the submit button disabled during inspection or an unresolved path error.

**Acceptance:** Opening either tab causes no implicit project selection. Browsing home does not enable adoption by itself. A typed path, displayed listing, inspection result and submitted target must agree. Failure to inspect is not equivalent to approval.

### F05 — Recovery choices hide both consequences and partial work

**P0 · B/S · `node/Recover.tsx`, `node/useNodeActions.ts`, server recover route**

Resume, Discard and Keep are three equally terse choices. Discard immediately calls a destructive recovery endpoint without confirmation. Keep clears the interrupted status while leaving the worktree dirty; that is not the same as saving a completed result. The browser also showed recovery inserted above the current scroll position, while the viewport remained at the end of the conversation. The supposedly leading recovery action was offscreen.

**Replace:** a persistent recovery notice outside the scrolling transcript, with “Review partial changes,” “Resume run,” “Keep partial work,” and “Discard partial changes…” as explicit actions. Explain that Keep does not commit the work. Preserve a visible partial-work indicator after Keep. Confirm Discard with the target node and affected files, including untracked files. Do not label this as undo or add history rewriting.

**Acceptance:** After stopping a run that wrote an untracked file, the user can see what remains before deciding. Discard requires a deliberate confirmation. Keep does not produce an apparently clean “ready” result with hidden dirty work. Adopted-root restrictions remain enforced on the server.

## 5. Findings: the core experiment workflow

### F06 — Project creation has an avoidable dead end and two starts

**P1 · B/S · `StartScreen.tsx`, `App.tsx`, `Panel.tsx`, `node/StartRun.tsx`**

Create project produces a lone unselected “master” node. Its empty side panel says to select a node. Selecting it then reveals a prefilled Start form and a second empty Send composer. The two controls initiate the same kind of run but invite different interpretations. A checkout command also appears before the initial agent run.

**Replace:** automatically select the returned root after the server confirms creation. Present one editable initial prompt and one “Start first run” action, clearly stating whether project creation has already run anything. Hide the ordinary reply composer and nonessential checkout section until relevant. After the run begins, the same prompt becomes the first transcript turn.

**Acceptance:** A newcomer can create the scaffold without clicking an unexplained card or choosing between Start and Send. Exactly one submission surface exists in the new state. Retry cannot accidentally submit the same first run twice.

### F07 — The branching dialog does not explain what the new experiment inherits

**P1 · B/S · `NewChildDialog.tsx`, `state/useChildCreation.ts`, `node/Lineage.tsx`**

“New child of…” names a parent but does not disclose separate code and conversation sources. The distinction appears only after creation, even though it is the product's central concept. Creating a child from an exploration is precisely when a user needs to understand it.

**Replace:** add a compact pre-submit inheritance summary using server-provided lineage: “Conversation: Negative-number discussion. Code: Argparse approach.” Link the named sources to selection after closing the dialog. If a parent's run is still active, state what snapshot is used or explain why branching is unavailable according to the resolved policy.

**Acceptance:** For the demo's fifth node, the user can name both sources before Create and run. The UI must not compute the nearest committing ancestor independently of the backend.

### F08 — A test-agent convention leaks into the real product

**P1 · B/S · `NewChildDialog.tsx`, `agent/FakeRunner.ts`**

The placeholder says “Start with ? to just ask.” That convention is implemented by FakeRunner. The real product defines exploration by what the agent actually did. The placeholder implies a mode guarantee the real interface does not provide and leaves question marks in derived names.

**Replace:** “Describe an experiment or ask a question.” Explain once that Bonsai records whether files changed after the run. Do not introduce a change/exploration type picker. If guaranteed read-only intent is wanted, that is a separate product decision and must be enforced by the backend.

**Acceptance:** Normal production copy contains no FakeRunner syntax. Plain-language questions work without prefix knowledge. A user cannot mistake a punctuation convention for enforced permissions.

### F09 — “Branch a child from this node” is implementation language and moves around

**P1 · B/J · `Panel.tsx`**

The central product action is a long dashed button. It appears before the conversation on frozen nodes and after it on writable nodes. Moving it acknowledges state, but makes the user rediscover the same action as the tree evolves. The dashed styling also resembles a placeholder rather than a stable command.

**Replace:** one consistently located “Branch experiment” action near the panel header. Let its emphasis change with capability: primary when editing here is unavailable, secondary while continuation is the primary task. Keep the drag gesture as a shortcut to this same flow.

**Acceptance:** Branching remains visible without scrolling through a long conversation in either writable or frozen states. Do not duplicate the whole form in a second panel region.

### F10 — The product cannot explain its own freeze rule consistently

**P1 · S · Decision required**

Start copy says a node remains editable while it is a leaf. Details and Composer say it froze when a child committed. The implementation permits an ancestor with a question-only child to remain writable. This happened in the reviewed five-node tree. The project instructions require a different rule.

**Replace after decision:** use one capability sentence everywhere: whether code can change and the specific reason if it cannot. Avoid forcing users to translate “leaf” into an action. Preserve separate explanations for an adopted root and a node frozen by descendants.

**Acceptance:** The approved rule is documented once and covered by backend tests. Card, composer, creation dialog and Details agree for no children, question-only children, a committing child, and an adopted root.

### F11 — Green “ready” looks like success, although it means only completion

**P1 · B/S/J · `nodeStatus.tsx`, `NodeCard.tsx`, `Checks.tsx`**

A green check and “ready” are the dominant completed-state cues. They can be read as a successful experiment or passing checks, although the implementation means only “the last run finished.” Meanwhile “stopped” combines deliberate cancellation and failure, and a running card replaces the status label with Stop.

**Replace:** distinguish execution state, code outcome, and recorded verification. Use “Finished” for execution, “Files changed” / “Answered without file changes” for outcome, and factual check notes for evidence. Distinguish cancelled from failed when recorded run data supports it. Retain shape plus text, and display Stop alongside rather than instead of an understandable active status.

**Acceptance:** A finished run with failing checks never visually implies those checks passed. A question-only result does not look deficient because it has “no commit.” No new verdict enum should be inferred from agent prose.

### F12 — The experiment goal is optional, but almost invisible

**P1 · B/J · `NewChildDialog.tsx`, `Checks.tsx`**

Hiding two optional fields reduces friction, which is good. Hiding all encouragement to define success weakens the product's reason to exist. A tree of prompts and green chips tells users where they tried things, not whether any approach met the goal.

**Replace:** retain one required prompt, but expose a small optional “Success looks like…” field or prompt-adjacent nudge. Keep technical verification instructions behind a disclosure. In completed review, show Goal, Recorded checks, and Remaining uncertainty together. Do not turn creation into a mandatory test-writing wizard.

**Acceptance:** Blank criteria still permit quick questions. A user who wants a structured experiment can add its goal without exploring an obscure menu. The result clearly says when no verification was recorded.

### F13 — Derived names repeat the prompt, then cannot be repaired after creation

**P1 · B/S · `NewChildDialog.tsx`, `NodeCard.tsx`, `Panel.tsx`**

Several cards repeat essentially the same sentence as title and summary, then truncate both. There is a rename control during creation but no post-creation rename control in the reviewed panel; the overflow contains only Delete. Comments justify automatic names by saying they can be renamed later, but the product does not provide that path.

**Replace:** retain automatic naming, expose Rename in node actions or an explicit header affordance, and avoid duplicating identical summary text on a card. Use a short experiment label plus a distinct objective or factual outcome. Rename changes metadata only.

**Acceptance:** Rename any node, including a frozen one, without changing its branch or history. A long prompt does not produce two indistinguishable truncated lines. Full names remain available without hover alone.

## 6. Findings: inspection, navigation, and feedback

### F14 — Run grouping is right; the panel still mixes several jobs in one sequence

**P1 · B/J · `Panel.tsx`, `Transcript.tsx`**

Checks, lineage, conversation, branching, details and checkout all occupy the same reading column. One scroll region is better than nested transcript scrolling, but it does not establish an information hierarchy. Increasing panel width alone will not solve the mixed purposes.

**Replace:** keep a fixed identity/action header, a small state or evidence summary, a run transcript as the default reading surface, and one composer. Put durable metadata and the technical checkout command behind secondary disclosures. Provide a direct way to review this experiment's aggregate changes without searching past runs. Do not add a tab for every component; optional Conversation / Changes navigation should correspond to distinct tasks, not implementation files.

**Acceptance:** A person can read the latest answer, inspect changes, and branch again without repeatedly scrolling past unrelated metadata. The same information should not be fully duplicated in a summary and a Details list.

### F15 — Per-run diffs do not replace the experiment's complete change set

**P1 · S/J · `Transcript.tsx`, `Diff.tsx`, API `diff` and `runDiff`**

The new renderer gives each run a Changes disclosure, but the reviewed panel has no entry to the existing node-level diff endpoint. After several runs, the user must reconstruct the total result mentally. That is especially poor for an experiment that is a branch with several commits.

**Add within existing capability:** “All changes in this experiment” alongside per-run “Changes from this run.” Clearly label the comparison base and distinguish committed changes from current partial work. This is one node against its base, not side-by-side comparison between nodes.

**Acceptance:** After three modifying runs and a question, aggregate inspection is available in one direct action. The node and run scopes cannot be confused, and untracked partial work is not hidden.

### F16 — Changes can silently open to nothing

**P1 · B/S · `Transcript.tsx: RunDiff`, server `store.runDiffBase`**

Opening Changes on the root's first run showed an expanded control with no content or error. Child-run diffs did load. The client swallows failures, and the server's base lookup can return no base for the first root run even though project initialization created an earlier commit.

**Replace:** explicit loading, loaded-empty, failed and loaded-diff states. Resolve the root run's correct pre-run snapshot in the backend. Keep Retry available. Do not describe an unavailable diff as “No textual changes.”

**Acceptance:** The initial scaffold's changes are inspectable. A forced diff failure produces a visible reason and retry action. Slow loading has feedback before the result arrives.

### F17 — The diff viewer needs inspection affordances, not decorative complexity

**P2 · B/S/J · `Diff.tsx`, `diffModel.ts`, `styles.css`**

File grouping, counts, visible addition/deletion markers and Copy patch are useful. Long paths and code remain cramped in a 360px panel. Hunk headers exist, but line numbers and clearer file operation labels would improve orientation. When parsing produces no files, the component returns before showing `dirty`, potentially hiding uncommitted files in exactly the state recovery needs to explain.

**Improve:** preserve grouping; add clear added/deleted/renamed/binary labels where the patch supports them, line references, a readable expanded view, and a persistent dirty/untracked summary independent of textual patch availability. Distinguish “no text diff” from “no changes.” Surface clipboard failure.

**Acceptance:** Review a long filename, a rename, deletion, binary-only patch and untracked-only worktree. Each has truthful feedback. Large diffs remain readable without reintroducing side-by-side node comparison.

### F18 — Live reading loses its place and provides no route back to new output

**P1 · B/S · `chat/useChat.ts`, `Panel.tsx`**

The hook follows the bottom only when the distance is under 160px, but it measures after content changes. Large appended content can move a previously bottom-aligned reader outside that threshold. The end of the scroll region is also checkout/details rather than necessarily the latest reply. During the review, the panel arrived partway through checks, and recovery could be inserted above the viewport.

**Replace:** track whether the reader was following before an update, preserve a node-specific reading position, and show “New output” / “Jump to latest” when they are reading older material. Keep urgent actions visible outside that scroll logic. Do not force-scroll while the user selects or reads earlier text.

**Acceptance:** Long output, switching nodes, opening a diff and cancelling a run preserve a predictable reading position. Newly required user actions cannot be offscreen without a visible cue.

### F19 — Tool activity can still dominate while the agent is running

**P2 · S/J · `ToolCalls.tsx`, `Transcript.tsx`**

Grouping adjacent tool calls preserves the narration and should stay. Automatically expanding every live group can still turn the panel into a tool log, especially with long paths. The user generally wants what is happening, whether progress continues, and whether attention is needed.

**Improve:** default to a concise current activity line plus expandable technical detail. Preserve chronological grouping and a user's expansion choice. Give the assistant's final response clear separation from activity. Render actual recorded tool data; do not invent progress percentages or successful steps.

**Acceptance:** A long run remains understandable without reading tool names. Opening details still exposes the underlying activity. User and assistant authorship is unambiguous across consecutive runs.

### F20 — History needs to be read as content, not just rendered as text

**P2 · S/J · `Markdown.tsx`, `markdown.ts`, `Transcript.tsx`**

The renderer supports common headings, lists, code and links, a major improvement over raw prose. It does not provide full rich Markdown coverage such as tables, and code blocks have no dedicated copy action. There is little support for quickly returning to a previous run beyond scrolling.

**Improve:** cover the response structures the agent actually emits, particularly tables and nested/task lists, with safe rendering and graceful fallback. Add code-copy feedback and a lightweight per-run collapse or jump mechanism if user testing shows long conversations warrant it. Do not build global search, a document editor, or a command terminal.

**Acceptance:** Long code, a table and a nested list are legible at the supported panel width. Unsafe links remain inert. Copy does not include UI labels or line markers. Text can be selected without triggering canvas actions.

### F21 — Failure can masquerade as an empty conversation or a healthy connection

**P1 · B/S · `App.tsx`, `useProjectTree.ts`, `useChat.ts`, API `subscribe`**

When the local test server stopped, the canvas retained “ready” cards and a green “stand-in” connection pill. Opening the panel could show “No conversation yet” despite historical messages, alongside a server error. Message fetch failures are swallowed, and SSE has no user-visible connection state. Provider credential health and contact with the local server are different signals.

**Replace:** explicit “Loading conversation,” “Conversation unavailable — Retry,” and stale-data states. Expose local-server/event-stream reconnecting status separately from model credentials. Keep existing content labeled as last known when safe; never replace a failed fetch with an authoritative empty state. Reconcile the tree after reconnect. Make errors dismissible or clear them once the associated operation succeeds.

**Acceptance:** Server down, network interruption, empty transcript and genuinely new node are visibly distinguishable. Recovery restores current state without duplicating runs. Cancellation failures are shown beside the action.

## 7. Findings: settings, permissions, and exceptional states

### F22 — Settings combine different scopes and save behaviors

**P1 · B/S · `SettingsDialog.tsx`, `NewNodeSetup.tsx`, server settings/project routes**

Connection, global agent defaults, global locations, project-specific setup and diagnostics share one long modal. Some controls autosave; others have Save buttons. The hint “applies to new projects” is far from the selected node whose future run the user may intend to change. The connection/model pill is not a reliable statement of that run's effective configuration.

**Replace:** clearly labeled App settings and “Project settings — [name]” groups. Give each group a consistent save contract and visible Saved/Failed state. Show effective settings and their scope before starting work, using server-resolved values. Do not add per-node overrides as part of this audit.

**Acceptance:** A user can tell whether changing a value affects this project, future projects, or all active scheduling. Reload confirms saved values. Failed saves neither disappear silently nor leave the control looking definitively saved.

### F23 — Default environment warnings teach users to ignore warnings

**P1 · B/S · `NewNodeSetup.tsx`, project setup defaults, `runNode.ts`**

Every reviewed child emitted “Could not copy .env…not found.” The test project had no environment file, yet `.env` was preconfigured in the setup list. Repeated avoidable warnings make real setup failures harder to recognize and crowd the transcript.

**Replace:** use deliberate project configuration or clearly distinguish optional absent files from required setup failures. Show setup needs before the first experiment where possible, and report setup output in a contextual activity section with a path to project setup settings. Do not silently ignore a required file failure.

**Acceptance:** A simple new CLI that needs no environment file starts without repetitive missing-.env warnings. A deliberately configured missing file produces one specific, actionable explanation.

### F24 — Authentication blocks access to locally stored history

**P1 · S/J · Decision required · `App.tsx`, `ConnectionScreen.tsx`**

Any connection state other than connected replaces the entire app. A rate limit can therefore stop a person reviewing results that already exist locally. This conflates permission to start paid work with access to their own history.

**Propose:** allow read-only project/history access while showing a persistent connection problem and disabling new runs with a reason. Keep real-agent gating; never silently fall back to simulated output. Improve the login flow to say when a browser or terminal is needed before the user clicks, and display operation errors near the relevant action.

**Acceptance if approved:** Expired credentials do not hide prior experiments. Starting a run remains blocked truthfully. Initial connection checking is a loading state, not a fully active sign-in form. No real auth flow was tested in this audit.

### F25 — Permission requests need action-specific context and their own state

**P1 · S · `node/AskBox.tsx`, `Panel.tsx`, server question contract**

The allow/refuse split correctly avoids pretending that approval can include an instruction. However the generic question and one-line refusal field do not necessarily make a large edit or command understandable. Input state is not keyed to question ID; text can survive a node/question switch. A disabled ordinary composer remains nearby during an approval request.

**Replace:** a clearly identified request card: requesting node, action, target, and expandable recorded details. Label the text field “Reason or alternative instruction (sent when refusing).” Reset or scope its draft per question. Give “Already answered” a specific outcome rather than generic busy advice. Let the request replace the ordinary composer while it is active.

**Acceptance:** Approve, refuse with guidance, cancel, switch between pending questions, and answer from another window. The correct question receives the correct text; no default implies broader permission than the single action.

### F26 — Stop and queue controls are inconsistent across surfaces

**P1 · S/B · `App.tsx`, `NodeCard.tsx`, `useNodeActions.ts`, `nodeStatus.tsx`**

The panel offers Stop for running and needs-you states. Cards offer it only for an actively running, nonqueued node. Stop all counts only running nodes, although a parked permission request also holds an agent slot. Some cancellation calls lack an error handler or an in-progress state. A cancelled run can initially show the generic “killed or failed midway” text before details refresh.

**Replace:** use a backend-aligned definition of active jobs for counts and cancellation. Show “Stopping…” until confirmed, handle failures locally, and identify queued versus working versus waiting for permission. Use recorded cancellation reason once available and neutral transitional copy before it arrives.

**Acceptance:** Cancelling a queued job and a permission-blocked job is discoverable. Stop all describes exactly the affected set. Repeated clicks do not create confusing duplicate requests, and a failed stop cannot look successful.

### F27 — Destructive project deletion is better protected than partial-work discard

**P1 · S/J · `ConfirmDialog.tsx`, `deletionMessage.ts`, `useNodeActions.ts`**

The branch improved deletion by using an app dialog, impact counts and a typed project confirmation. Preserve those protections. Node deletion still relies on a generic Delete label; technical terms such as “commit-bearing branches” add cognitive work. The distinction between deleting an app-owned project and removing Bonsai's experiment data from an adopted folder is especially consequential.

**Improve:** name the object in the action and summarize exact removal and preservation in compact, separate statements. For subtree deletion, include descendant count and meaningful names where feasible. Keep destructive style distinct from ordinary Stop. Make cancellation the default focused action and fix modal focus behavior under F32.

**Acceptance:** Users can state what will remain on disk before confirming. Server-side ownership checks remain authoritative. No undo/archive promise is added while those features are deferred.

### F28 — Diagnostics promise more sanitization than the UI can prove

**P1 · S · `Diagnostics.tsx`, server diagnostics route**

The button immediately gathers and copies data. A code comment says it is shown before copying, but the user receives no review step. The UI promises “No key, no prompts, no file contents,” while the endpoint includes node display names, run records and recent log lines. Names can derive directly from prompts, and error/log content needs explicit redaction review.

**Replace:** Generate report → preview the exact payload → Copy. State what categories are included accurately and validate sanitization in the backend. Diagnostics should help the user share selected evidence, not encourage pasting an unreviewed blob into an issue.

**Acceptance:** Test with a secret-like string in a prompt-derived name and error text. The documented redaction policy matches actual output. Gathering and clipboard failures remain separately recoverable. This is an output-contract concern, not a claim that a real secret was exposed during this audit.

### F29 — Folder actions and checkout commands have misleading labels

**P2 · B/S · `MenuBar.tsx`, `Checkout.tsx`, `SettingsDialog.tsx`**

“Open Bonsai's data folder” actually reveals `settings.reposRoot`, while Settings has a distinct `dataDir`. “Get this branch” is always expanded when a command exists, takes valuable panel space, and exposes long generated refs. A browser user may expect an action that opens the result, not instructions to operate git elsewhere.

**Replace:** label folder destinations exactly. Keep the existing checkout escape hatch in a secondary “Use this code outside Bonsai” disclosure, subject to the branch-name decision. Explain where to run the command and whether it includes only committed work. Reset “Copied” when the command changes; show failures. Do not add an Execute button or an export workflow.

**Acceptance:** Each reveal label matches the endpoint's actual destination. Partial uncommitted work is not implied to be included in the checkout result. The primary workflow does not depend on reading generated branch names.

## 8. Findings: visual design, accessibility, and identity

### F30 — The screen is visually quiet but too uniformly small

**P2 · B/S/J · `styles.css`**

The dark surfaces and violet accent are coherent enough to retain. The problem is density and hierarchy: body text is 13px, most hints and code are 11–11.5px, and several headings barely exceed metadata. On a 720px-high window, the new-project form's folder browser pushes the main action to the bottom edge. The 360px default reading panel wraps explanations and clips long titles.

**Direction:** use approximately 14–15px for primary reading, 12–13px for secondary information, and 13px or larger code where practical. Treat these as starting design values to validate, not universal standards. Collapse location browsing, reserve short muted text for secondary facts, and allow the panel a comfortable reading width while preserving canvas space.

**Acceptance:** A user can read the latest response and the creation action at 1280×720 without relying on browser zoom. Longer content still scrolls naturally. Essential instructions are not visually demoted to footnotes.

### F31 — Contrast needs measurement, not a blanket “make it brighter” request

**P2 · S/J · `styles.css`**

Calculated solid-color ratios from current tokens are approximately 4.95:1 for muted text on surface, 4.56:1 on surface-2, and 4.62:1 for white on the primary violet. These pairs meet the 4.5:1 normal-text reference threshold; calling all muted text inaccessible would be inaccurate. Conversely, the strong border against the surface is about 1.55:1, and the translucent focus ring warrants rendered-state checks.

**Direction:** verify every text, focus and control-boundary state on its actual background, including hover, mixed backgrounds and disabled explanations. Distinguish decorative borders from boundaries necessary to identify controls. Increase important focus visibility and preserve readable explanatory text beside disabled actions.

**Acceptance:** Record rendered contrast results for the token matrix and representative controls. Do not claim complete WCAG conformance from four token calculations. Reference: [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

### F32 — Modals look modal but do not behave modally for the keyboard

**P1 · B/S · `SettingsDialog.tsx`, `NewChildDialog.tsx`, `ConfirmDialog.tsx`**

Opening Settings left focus on the toolbar's Settings button. Pressing Tab moved to the connection button behind the dialog. Settings and child creation do not establish modal focus containment; Confirm supplies `aria-modal` but no focus trap. Escape and backdrop dismissal exist, but they are not the complete interaction.

**Replace:** one shared accessible dialog primitive with initial focus, contained tab navigation, an inert background, an accessible title, and restored focus on close. Protect a dirty form from accidental backdrop dismissal, or preserve its draft. A busy child-creation dialog should not misleadingly disappear as though creation was cancelled when the server may already be working.

**Acceptance:** With keyboard only, tab through and out of each dialog in both directions; focus never enters the obscured app. Closing returns to the opener. Deletion focuses Cancel. Reference: [W3C modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### F33 — The signature branching gesture looks like wiring, not creation

**P1 · B/S/J · `NodeCard.tsx`, `Canvas.tsx`, `styles.css`**

The source handle is a small hollow circle, about 10px before canvas scaling. It has no visible plus despite comments describing one. A title tooltip explains dragging, but new users need to discover both the target and the gesture. The panel alternative exists, which is good; it should be the primary discoverable route.

**Improve:** a visible plus affordance on hover, selection and keyboard focus, with a comfortably sized hit region and an equivalent labeled button. Drag should place an experiment, not be a prerequisite for creating it. Clearly explain that dropping on another node does not merge or connect them.

**Acceptance:** The demo can be completed without dragging. Evaluate effective target sizes and neighboring targets at supported zoom levels; WCAG's minimum reference is 24×24 CSS pixels with defined exceptions, not a blanket requirement that every drawn circle be 24px. Reference: [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

### F34 — Canvas symbols and edge styling are not self-explanatory

**P2 · B/S/J · `NodeCard.tsx`, `layout.ts`, `nodeStatus.tsx`**

An envelope represents a conversation-only node, a padlock means at least two different reasons for read-only behavior, and dashed borders/edges carry meaning mainly explained on hover. At low zoom, running and completed nodes both use circles differentiated chiefly by color. The tree's arrows do not independently explain the separate code lineage.

**Improve:** a compact, dismissible canvas key; consistent conversation and lock icons; accessible text for all states; and a selected-node lineage highlight. Keep one tree of conversations, with code source explained on selection rather than drawing every possible relationship permanently. Preserve text or meaningful non-color distinctions at compact zoom.

**Acceptance:** A user can identify a question-only node and explain the selected child's code source without interpreting an envelope or reading a UUID. Screen-reader edge labels name the experiments instead of “Edge from [UUID] to [UUID].”

### F35 — Canvas movement does not preserve enough orientation

**P2 · B/S/J · `useLaidOutNodes.ts`, `layout.ts`, `Canvas.tsx`**

The app refits the whole tree whenever node count changes. This keeps new nodes visible but can repeatedly change the scale and location of work the user is reading. Manually moved nodes are pinned, yet no visible “return this node to automatic layout” control exists. Layout calculations use a 220×76 card while rendered cards vary and can be taller.

**Improve:** preserve viewport during background updates; reveal a newly created node with the minimum necessary movement; retain an explicit Fit tree control. Make pinned positioning understandable and reversible to null through the existing API. Align layout assumptions with actual card geometry. Test top-to-bottom versus left-to-right for deep chains before changing direction; current top-to-bottom is not inherently wrong.

**Acceptance:** Adding a node does not unexpectedly shrink a readable tree into symbols. Dragging and returning to automatic layout are understandable. Long names, variable summaries and state changes do not create overlap.

### F36 — Small windows have no alternate composition

**P1 · B/S · `styles.css`, `PanelResizer.tsx`**

At 800×720 the fixed-width panel leaves a narrow canvas and clips previously visible nodes until refitting. At 480×720 the toolbar overlaps the panel heading and the canvas is reduced to a thin strip. There are no viewport breakpoints for the app layout. This matters for split-screen desktop work and enlarged text, even without a mobile-product ambition.

**Replace:** below a tested minimum canvas width, switch between Map and Experiment views with a clear back action, or use a full-width detail drawer. Clamp resizing against available viewport space, not only a fixed min/max. Provide a close/collapse panel action. Forms and dialogs should fit and scroll inside the viewport.

**Acceptance:** Core actions remain operable at 800px width and at 200% browser zoom on the supported desktop size. At narrower widths, content changes composition instead of overlapping. This does not require shipping a separate mobile app.

### F37 — The branding is a placeholder and the icons belong to different systems

**P2 · B/S/J · `Logo.tsx`, `index.html`, `nodeStatus.tsx`, `NodeCard.tsx`**

The built-in mark is explicitly labeled a placeholder in source, and no custom `public/logo.png` is present. At toolbar size it reads as fine linework rather than an immediately recognizable Bonsai identity. The mark, envelope, colored padlock emoji, typographic arrows and status glyphs have different visual weights. The favicon uses a separate encoded asset, allowing it to drift from the app mark.

**Direction:** retain Bonsai as the identity and explore a simple branching/tree symbol that survives 16–24px rendering. Use a wordmark on onboarding and a compact mark in the workspace. Adopt one small SVG icon family, built with existing assets or local vectors rather than adding a dependency without approval. Generate the favicon from the same approved source. Do not spend the first sprint designing an elaborate botanical illustration.

**Acceptance:** The approved mark is recognizable in monochrome and at small sizes; favicon and app agree. Icons have consistent stroke and baseline. Custom masks require transparent assets, and opaque fallback artwork cannot silently become a solid square.

### F38 — Microcopy and keyboard conventions need one consistent contract

**P2 · B/S/J · UI-wide**

The UI alternates between node, child, branch, master, leaf, worktree, conversation-only and commit. Labels vary between sentence case, lowercase and raw model identifiers. Creation and chat submit on Enter, but Shift+Enter is not always explained; composition events are not guarded. Project menu items and tab-like buttons lack a complete consistent accessible navigation pattern. The resizer already supports arrow keys and reduced-motion styles already exist; preserve those strengths.

**Direction:** use experiment for the user's work unit, node when explaining the map, run for one agent request, and code snapshot for inheritance explanations. Prefer “Starting point” as a display label if approved; never rename the underlying git branch as a cosmetic task. Use sentence case, persistent field labels and clear submit shortcuts. Consider Ctrl/Cmd+Enter for multi-line experiment instructions; validate before changing established behavior. Guard IME composition and make menus/tabs keyboard-operable with appropriate semantics.

**Acceptance:** A keyboard-only user can create a project, select a node, branch, submit, stop and close dialogs. Chinese/Japanese composition cannot accidentally submit. Status/error announcements are concise, and decorative glyphs are not the only accessible names.

## 9. Recommended product composition

These are proposed design decisions for review, not instructions to implement every optional enhancement at once.

### Workspace

The canvas remains the map of experiments. The side panel remains the place to work on one selected experiment. Do not add a permanent navigation rail just to make the app resemble a larger product.

| Region | Primary content | Remove or demote |
| --- | --- | --- |
| Project bar | Project selector/name, Settings, clear connection health, labeled estimate when relevant | Separate static project name plus a distant Project menu; misleading raw model-as-connection label |
| Canvas | Experiment names, meaningful state, lightweight outcome, selection and lineage orientation | Duplicate prompt summaries, dominant cost trivia, unexplained symbols |
| Panel header | Full experiment identity, capability, Branch experiment, contextual Stop, overflow with Rename/Delete | Branch button moving above/below history; destructive action beside routine submission |
| State notice | Pending permission, recovery, or connection issue when applicable | Urgent action buried in scrolling content |
| Result summary | Goal and attributed testing evidence, concise code/conversation sources | Generic green success implication; inherited checks with no provenance |
| Reading area | Run transcript by default; direct aggregate/per-run changes access | Always-open raw checkout command and long metadata inventory |
| Composer | One node-owned prompt, contextual send action, visible effective run settings/scope | Separate Start and Send boxes for the same initial request |

### State-specific next action

| State | Leading action | Supporting action | Required explanation |
| --- | --- | --- | --- |
| New | Start first run | Edit initial request | Work has not started; run uses the shown settings. |
| Running | Stop run | Read live work / draft next message | Current activity and elapsed time when available; no invented percentage. |
| Queued | Cancel queued run | Inspect prior work | Waiting for a slot; queue position if supplied. |
| Needs permission | Allow or Refuse the specific request | Stop run | Exact action and target, scoped to this request. |
| Finished and writable | Continue this experiment | Branch experiment / inspect changes | Whether files changed and what was checked. |
| Frozen | Branch experiment | Ask about this snapshot | Why files cannot change here; later conversation does not retroactively update existing children. |
| Adopted root | Branch experiment | Ask about the starting code | The original folder remains read-only to Bonsai. |
| Interrupted | Review partial work / Resume | Keep partial work / confirmed Discard | What remains, whether committed, and which actions change or remove it. |
| Failed fetch | Retry the affected section | Navigate elsewhere if safe | Data unavailable is different from data absent. |

### Suggested copy examples

| Current | Proposed | Why |
| --- | --- | --- |
| Branch a child from this node | Branch experiment | Short, product-focused action. |
| ready | Finished | Separates run completion from successful verification. |
| no commit | Answered without file changes | Explains the user-visible outcome. |
| Did it work? | Checks for this run | Use only when provenance supports it; otherwise explicitly label inherited/older notes. |
| Start with ? to just ask | Describe an experiment or ask a question | Removes test-only instructions. |
| Keep | Keep partial work | Avoids implying completion or a commit. |
| Discard | Discard partial changes… | Names the destructive consequence. |
| Get this branch | Use this code outside Bonsai | Explains the existing technical escape hatch's purpose. |
| tokens ≈ followed by dollars | API-equivalent estimate | Units must match the number. |

Cost appears on cards, run footers, Details and the project bar. Multiple levels can be useful, but each should identify its scope and units. Keep project estimate, run estimate and node total distinct. Subscription API-equivalent values must not appear to be additional bills. Validate the live billing/model details separately; no real billing assumptions were verified here.

## 10. Implementation handoff and validation

### Work package acceptance gates

**Gate A — Trust:** F01–F05 pass before cosmetic work is called complete. Add focused integration checks for wrong-node content/drafts and inherited evidence. Exercise folder selection and discard without touching personal data.

**Gate B — Core journey:** A new user completes the five-node demo without reading the repository README. They can explain both sources of the final child, differentiate continuation from branching, and find their next action in every state.

**Gate C — Review:** The first root run, later runs, and aggregate node changes are inspectable. A failed diff is visibly failed. Testing evidence is attributed and does not imply a verdict.

**Gate D — Exceptional behavior:** With temporary fixtures, exercise queued, needs-you, cancelled, failed, reconnecting and unavailable states. Validate cancellation outcomes and destructive consequences. A UI error must not silently turn an active run into an apparently finished one.

**Gate E — Visual and input quality:** Check desktop and constrained windows, browser zoom, keyboard navigation, focus visibility, reduced motion, long content, and effective target sizes. Existing canvas visibility across refetch tests should remain intact.

### Concrete review scenarios for the next agent

| Scenario | Required observation |
| --- | --- |
| Create a fresh project | Root is selected; one initial prompt; resolved location; no false claim that scaffolding already ran. |
| Branch two alternatives | Both are visible; clear labels; no duplicate creation form; predictable viewport. |
| Ask a question under A; branch from that question | Conversation source is the question, code source is the nearest committing ancestor, disclosed before and after creation. |
| Write drafts in A and B | Each stays with its owner through switching and delayed submission acknowledgment. |
| Delay/fail B's data request after viewing A | B never displays A's data as its own. |
| Parent has testing notes; child has no new checks | Child labels inherited evidence or says no new checks recorded. |
| Run three changes in one leaf | Per-run and aggregate changes are clearly separate and correct. |
| Stop after an untracked file is written | Partial work is visible; recovery controls stay reachable; discard is confirmed. |
| Press Keep | Dirty/partial state remains visible and its resume behavior is explicit. |
| Agent waits for permission | Exact request is readable; correct question receives response; cancellation works. |
| Lose contact with local server | Connection indicator, stale state and Retry agree; history does not become “no conversation.” |
| Existing-folder picker opens | No accidental home-directory selection; resolved target is explicit. |
| Type an invalid path or switch folders rapidly | No stale inspection approves the wrong path; errors are local. |
| Keyboard through every modal/menu | Focus stays where expected, background is inert while modal, Escape restores focus. |
| Narrow window and 200% zoom | No overlapping toolbar/panel or unreachable submit controls. |
| Long names, paths, Markdown and diff | Content is readable, selectable and copyable; card layout remains stable. |

### Qualitative validation with people

After the first two work packages, run short observed sessions with people who code through agents but do not know Bonsai's internals. Ask them to complete the demo and explain what each experiment inherited. Do not teach the workflow during the test.

Record wrong-node submissions, requests for help, hesitation between Start/Send/Branch, success finding changed files, and misunderstandings of checks or frozen state. Suggested release goals are zero wrong-destination submissions and correct explanation of both lineages. These are proposed goals, not current measured results. A small formative study can identify problems but cannot establish a statistically reliable success rate.

### What not to add in this pass

Do not turn this report into a general-purpose IDE backlog. No merging, syncing, conflict resolution, existing-branch import, side-by-side node comparison, editing frozen history, pruning, archive, search, multi-user collaboration or hosting. Do not add a terminal, a dashboard of vanity metrics, speculative AI summaries, or a new component library simply to make the screen feel more substantial.

A light theme may be useful as a later preference, but it should follow a complete semantic token system and contrast validation. A theme picker is not the remedy for unreadable hierarchy. Large-tree navigation belongs to the deferred scalability discussion once the five-node experience is dependable.

## 11. Source map

Use this map with the finding IDs. The report's conclusions are tied to the reviewed commit; re-check behavior if implementation has moved.

| Area | Source |
| --- | --- |
| App composition and gating | [App.tsx](../../packages/ui/src/App.tsx) |
| Panel and action placement | [Panel.tsx](../../packages/ui/src/panel/Panel.tsx) |
| Drafts, messages and scrolling | [useChat.ts](../../packages/ui/src/panel/chat/useChat.ts), [Composer.tsx](../../packages/ui/src/panel/chat/Composer.tsx) |
| Run rendering and diff loading | [Transcript.tsx](../../packages/ui/src/panel/chat/Transcript.tsx) |
| Change renderer and parser | [Diff.tsx](../../packages/ui/src/panel/chat/Diff.tsx), [diffModel.ts](../../packages/ui/src/panel/chat/diffModel.ts) |
| Agent activity and prose | [ToolCalls.tsx](../../packages/ui/src/panel/chat/ToolCalls.tsx), [Markdown.tsx](../../packages/ui/src/panel/chat/Markdown.tsx), [markdown.ts](../../packages/ui/src/panel/chat/markdown.ts) |
| New project flow | [NewProject.tsx](../../packages/ui/src/panel/NewProject.tsx), [StartScreen.tsx](../../packages/ui/src/panel/StartScreen.tsx), [DirectoryPicker.tsx](../../packages/ui/src/panel/DirectoryPicker.tsx) |
| New experiment flow | [NewChildDialog.tsx](../../packages/ui/src/canvas/NewChildDialog.tsx), [useChildCreation.ts](../../packages/ui/src/state/useChildCreation.ts), [StartRun.tsx](../../packages/ui/src/panel/node/StartRun.tsx) |
| Checks, lineage and details | [Checks.tsx](../../packages/ui/src/panel/node/Checks.tsx), [Lineage.tsx](../../packages/ui/src/panel/node/Lineage.tsx), [Details.tsx](../../packages/ui/src/panel/node/Details.tsx) |
| Recovery, permission and node actions | [Recover.tsx](../../packages/ui/src/panel/node/Recover.tsx), [AskBox.tsx](../../packages/ui/src/panel/node/AskBox.tsx), [useNodeActions.ts](../../packages/ui/src/panel/node/useNodeActions.ts) |
| Canvas, geometry and selection | [Canvas.tsx](../../packages/ui/src/canvas/Canvas.tsx), [NodeCard.tsx](../../packages/ui/src/canvas/NodeCard.tsx), [layout.ts](../../packages/ui/src/canvas/layout.ts), [useLaidOutNodes.ts](../../packages/ui/src/canvas/useLaidOutNodes.ts) |
| Project navigation and state | [MenuBar.tsx](../../packages/ui/src/canvas/MenuBar.tsx), [useProjectTree.ts](../../packages/ui/src/state/useProjectTree.ts), [useAddressBar.ts](../../packages/ui/src/state/useAddressBar.ts) |
| Settings and connection | [SettingsDialog.tsx](../../packages/ui/src/panel/SettingsDialog.tsx), [ConnectionScreen.tsx](../../packages/ui/src/panel/ConnectionScreen.tsx), [NewNodeSetup.tsx](../../packages/ui/src/panel/NewNodeSetup.tsx) |
| Copying and diagnostics | [Checkout.tsx](../../packages/ui/src/panel/node/Checkout.tsx), [Diagnostics.tsx](../../packages/ui/src/panel/Diagnostics.tsx) |
| Errors and event stream | [ErrorBoundary.tsx](../../packages/ui/src/ErrorBoundary.tsx), [describeError.ts](../../packages/ui/src/api/describeError.ts), [client.ts](../../packages/ui/src/api/client.ts), [useRunStream.ts](../../packages/ui/src/state/useRunStream.ts) |
| Dialog and resizing primitives | [ConfirmDialog.tsx](../../packages/ui/src/ConfirmDialog.tsx), [PanelResizer.tsx](../../packages/ui/src/PanelResizer.tsx) |
| Visual system and identity | [styles.css](../../packages/ui/src/styles.css), [Logo.tsx](../../packages/ui/src/Logo.tsx), [index.html](../../packages/ui/index.html), [nodeStatus.tsx](../../packages/ui/src/nodeStatus.tsx), [nodeCode.ts](../../packages/ui/src/nodeCode.ts) |
| Backend facts behind UI | [router.ts](../../packages/server/src/api/router.ts), [store.ts](../../packages/server/src/db/store.ts), [flags.ts](../../packages/server/src/domain/flags.ts), [context.ts](../../packages/server/src/git/context.ts), [contract.ts](../../packages/shared/src/contract.ts) |
| Product constraints | [PRD](../v0-prd.md), [decision log and backlog](../v0-decisions-and-backlog.md), [project rules](../../AGENTS.md) |

### Additional component notes

**Error boundary:** Keep a recoverable fallback and a clear statement that server-side jobs may still be running. Default to Reload; move the stack trace and the low-confidence “Try to carry on” action behind technical details. Avoid treating a React error as proof of a server crash.

**Empty selection:** Give the user an actionable next step tied to an existing node, not only a drag instruction. The empty inspector need not consume the full default reading width when nothing is selected.

**Recent projects:** The menu caps other projects at six and provides no explicit all-projects route. If the retained product supports more projects, expose the existing project list through the selector rather than adding global search. Remembering the last selected node per project is a view preference, not a new tree feature.

**Stale links and project requests:** `useProjectTree` silently substitutes the newest project for a missing bookmarked project, and tree loads do not guard against all out-of-order project responses. Show an unavailable-project explanation with a deliberate choice of another project; ensure a late request cannot switch the displayed tree behind the selected project identity.

**Error language:** `describeError` treats 409 as “already running,” but a permission question can also return 409 because it was already answered. Prefer operation-specific recovery guidance. Audit swallowed errors in reveal, save, copy and cancel paths; one generic top banner is not a substitute for local feedback.

**Creation partial failure:** Child creation performs create, optional placement, then start. A start failure can leave a created node while closing the dialog and reporting only a general error. Preserve the confirmed node, select it, and offer Retry start. Do not re-create it on retry or erase the user's submitted request.

**Selection model:** Keep selection as a list as required. The current renderer highlights only the primary item even though Ctrl/Cmd toggles list membership. Do not imply that invisible extra selection will cause a group action; V0 actions should clearly target the primary experiment.

**Theme priority:** Violet selection and blue running state are usefully separated. Do not force an all-green palette simply because the app is named Bonsai. A calm neutral canvas, readable content and a consistent small mark will establish identity more effectively than gradients or decorative trees.

## 12. Brief to pass to the implementation agent

Improve Bonsai's existing alpha around the five-node experiment journey. Start with F01–F05, then the workflow and review packages. Preserve the side-panel branch's run grouping, shared creation form, readable diffs, fixed composer, resizer and safer deletion placement. Do not treat the current component boundaries as fixed product requirements.

Before implementation, resolve the listed product-rule conflicts with the owner. Keep all tree and lifecycle decisions on the backend, render from capability flags, retain async jobs and cancellation, preserve immutable commits, and keep selection as a list. Ask before adding dependencies. Make small, reviewable changes and validate the affected acceptance scenarios, including slow/error states and keyboard operation.

The desired outcome is a person confidently choosing where to work, understanding what was inherited, and judging the evidence produced by each experiment—without needing to understand Bonsai's internal git machinery.
