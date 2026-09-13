# UI/UX milestones

Source: [product audit](reports/bonsai-ui-ux-product-audit-2026-09-13.md).

## Review workflow

The side-panel baseline was committed and merged into local `main` before this work.
Each milestone starts from the previously reviewed and merged milestone, on its own branch.
Finish implementation and checks, then pause for the owner to run the app, explore, and request
changes. Merge and push only after that review. Do not start the next milestone before the checkpoint.

| Milestone | Branch | Findings | State |
| --- | --- | --- | --- |
| 1. Protect users’ work | `codex/milestone-1-protect-work` | F01–F05 | Ready for owner review after validation |
| 2. Simplify starting and branching | `codex/milestone-2-start-and-branch` | F06–F10, F13 | Pending |
| 3. Make results easy to judge | `codex/milestone-3-judge-results` | F11–F12, F14–F17 | Pending |
| 4. Make ongoing work dependable | `codex/milestone-4-dependable-runs` | F18–F21, F25–F26 | Pending |
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
