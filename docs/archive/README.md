# Historical records

These documents preserve earlier design decisions, audits, and implementation plans.
They describe their original snapshots and may contain superseded behavior, paths,
validation results, and unresolved findings. They are not current user instructions.

- [Previous worktree architecture and execution flow](worktree-architecture.md)
- [Exact pre-shared-checkout source](https://github.com/MhmdAlTamimi/Bonsai/tree/archive/pre-shared-checkout)
- [Original product requirements](records/v0-prd.md)
- [Original decisions and backlog](records/v0-decisions-and-backlog.md)
- [Audit findings and fix plan](records/reports/audit-fixes-plan.md)
- [Shared-checkout implementation record](records/shared-checkout.md)

Current references: [installation](../installation.md), [usage](../usage.md),
[storage](../storage.md), [development](../development.md), and [architecture](../architecture.md).

## Repository consolidation

`main` is the active default branch. `archive/pre-shared-checkout` preserves commit
`28005fb437d0a7c6174402de64c3ed44ef811f1f`, including the old setup and implementation.
All completed development branches below were verified as ancestors of shared-checkout
commit `dab7c71f4a3d94089f785d7ffc8bf89444db8290` before retiring their branch names.
Their commits remain in Git history; branch retirement does not delete user projects or
remove support for unconverted worktree projects.

| Previous branch | Preserved head |
| --- | --- |
| `claude/apply-command` | [`1678053`](https://github.com/MhmdAlTamimi/Bonsai/commit/1678053a3146c76206ddad640b6579129c915489) |
| `claude/apply-fixes` | [`eb91a1e`](https://github.com/MhmdAlTamimi/Bonsai/commit/eb91a1e5d3bb882987a2536fd21bca65cc1eeabd) |
| `claude/audit` | [`d7f9c87`](https://github.com/MhmdAlTamimi/Bonsai/commit/d7f9c87018bdf555ca1b12251f601a2e185e4953) |
| `claude/bonsai-review-planning-d5j38w` | [`0b82d45`](https://github.com/MhmdAlTamimi/Bonsai/commit/0b82d452d47ae0c25154f57201323da5a98f7110) |
| `claude/consistency-pass` | [`fff8725`](https://github.com/MhmdAlTamimi/Bonsai/commit/fff872538cd312823951a7908465bf4683a85726) |
| `claude/experiment-app-uiux-audit-vtgh9d` | [`3ba6630`](https://github.com/MhmdAlTamimi/Bonsai/commit/3ba6630c4d5645ca7704f8dc73f9bc3e7bc37e38) |
| `claude/experiment-references-and-compare` | [`6b543c7`](https://github.com/MhmdAlTamimi/Bonsai/commit/6b543c71d35047e2900edb26c0d960b97ac842d4) |
| `claude/hidden-refs` | [`e7d4a98`](https://github.com/MhmdAlTamimi/Bonsai/commit/e7d4a984b191dfda5872c5fee52d5499c48afbbd) |
| `claude/maintainability-and-archive` | [`3bedbd9`](https://github.com/MhmdAlTamimi/Bonsai/commit/3bedbd93cf83ceccc8b0baedf7cb354268e431cf) |
| `claude/platform-fixes` | [`62d2e2e`](https://github.com/MhmdAlTamimi/Bonsai/commit/62d2e2e05e873bad718c8c49022c73e59ceceec6) |
| `claude/side-panel-rework` | [`d68d373`](https://github.com/MhmdAlTamimi/Bonsai/commit/d68d3739bd82b95e3d659edd0e2b5e5346216655) |
| `codex/audit-fixes` | [`28005fb`](https://github.com/MhmdAlTamimi/Bonsai/commit/28005fb437d0a7c6174402de64c3ed44ef811f1f) |
| `codex/phase-4-references` | [`8cb5d05`](https://github.com/MhmdAlTamimi/Bonsai/commit/8cb5d054422412dff964a699b0adcded5312dbf5) |
| `codex/phases-1-3` | [`8cb5d05`](https://github.com/MhmdAlTamimi/Bonsai/commit/8cb5d054422412dff964a699b0adcded5312dbf5) |
| `codex/stabilize-a-d` | [`7d25e8c`](https://github.com/MhmdAlTamimi/Bonsai/commit/7d25e8c6cbfa2499640f8472b1599feced9359bd) |

The shared-checkout branch can also be deleted after a merge that preserves its history.
The archive reference is retained for reference rather than ongoing development.

## Rollout checklist

- [x] Inspect every branch for work absent from the candidate.
- [x] Preserve the previous main source under an archive ref and document its architecture.
- [x] Separate current user/developer guides from historical records.
- [ ] Pass Linux and Windows checks on the final candidate.
- [ ] Merge shared checkout into main without rewriting existing history.
- [ ] Retire superseded branches after verifying the merge.

GitHub Actions records validation of each candidate. Branch retirement is a separate maintenance step.
