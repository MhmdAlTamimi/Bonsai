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

`main` is the active default branch. The previous implementation is preserved under
`archive/pre-shared-checkout` at commit `28005fb437d0a7c6174402de64c3ed44ef811f1f`,
including its original setup, source, and history.

The following branch heads were contained in the shared-checkout candidate
[`5527ab9`](https://github.com/MhmdAlTamimi/Bonsai/commit/5527ab9e2880818a53a6eff22c4091dad2070d7c).
Their names were retired after the merge. The recorded commits remain reachable from main;
removing branch names did not remove user projects or conversion support.

| Retired branch | Preserved head | Retirement check |
| --- | --- | --- |
| `claude/apply-command` | [`1678053`](https://github.com/MhmdAlTamimi/Bonsai/commit/1678053a3146c76206ddad640b6579129c915489) | Contained in main |
| `claude/apply-fixes` | [`eb91a1e`](https://github.com/MhmdAlTamimi/Bonsai/commit/eb91a1e5d3bb882987a2536fd21bca65cc1eeabd) | Contained in main |
| `claude/audit` | [`d7f9c87`](https://github.com/MhmdAlTamimi/Bonsai/commit/d7f9c87018bdf555ca1b12251f601a2e185e4953) | Contained in main |
| `claude/bonsai-review-planning-d5j38w` | [`0b82d45`](https://github.com/MhmdAlTamimi/Bonsai/commit/0b82d452d47ae0c25154f57201323da5a98f7110) | Contained in main |
| `claude/consistency-pass` | [`fff8725`](https://github.com/MhmdAlTamimi/Bonsai/commit/fff872538cd312823951a7908465bf4683a85726) | Contained in main |
| `claude/experiment-app-uiux-audit-vtgh9d` | [`3ba6630`](https://github.com/MhmdAlTamimi/Bonsai/commit/3ba6630c4d5645ca7704f8dc73f9bc3e7bc37e38) | Contained in main |
| `claude/experiment-references-and-compare` | [`6b543c7`](https://github.com/MhmdAlTamimi/Bonsai/commit/6b543c71d35047e2900edb26c0d960b97ac842d4) | Contained in main |
| `claude/hidden-refs` | [`e7d4a98`](https://github.com/MhmdAlTamimi/Bonsai/commit/e7d4a984b191dfda5872c5fee52d5499c48afbbd) | Contained in main |
| `claude/maintainability-and-archive` | [`3bedbd9`](https://github.com/MhmdAlTamimi/Bonsai/commit/3bedbd93cf83ceccc8b0baedf7cb354268e431cf) | Contained in main |
| `claude/platform-fixes` | [`62d2e2e`](https://github.com/MhmdAlTamimi/Bonsai/commit/62d2e2e05e873bad718c8c49022c73e59ceceec6) | Contained in main |
| `claude/side-panel-rework` | [`d68d373`](https://github.com/MhmdAlTamimi/Bonsai/commit/d68d3739bd82b95e3d659edd0e2b5e5346216655) | Contained in main |
| `codex/audit-fixes` | [`28005fb`](https://github.com/MhmdAlTamimi/Bonsai/commit/28005fb437d0a7c6174402de64c3ed44ef811f1f) | Contained in main |
| `codex/phase-4-references` | [`8cb5d05`](https://github.com/MhmdAlTamimi/Bonsai/commit/8cb5d054422412dff964a699b0adcded5312dbf5) | Contained in main |
| `codex/phases-1-3` | [`8cb5d05`](https://github.com/MhmdAlTamimi/Bonsai/commit/8cb5d054422412dff964a699b0adcded5312dbf5) | Contained in main |
| `codex/stabilize-a-d` | [`7d25e8c`](https://github.com/MhmdAlTamimi/Bonsai/commit/7d25e8c6cbfa2499640f8472b1599feced9359bd) | Contained in main |
| `codex/shared-checkout` | [`5527ab9`](https://github.com/MhmdAlTamimi/Bonsai/commit/5527ab9e2880818a53a6eff22c4091dad2070d7c) | Contained in main |
| `archive/pre-shared-checkout` | [`28005fb`](https://github.com/MhmdAlTamimi/Bonsai/commit/28005fb437d0a7c6174402de64c3ed44ef811f1f) | Archival tag verified before deletion |

The archive branch was replaced by the tag `archive/pre-shared-checkout` at the same
recorded commit. Main is now the only branch; the tag retains the complete previous
implementation and its history.

The one-time cleanup verified every expected head and confirmed each was contained in main.
It verified the archive tag before deleting the approved refs atomically with ref leases.
Future maintenance must preserve changed or unreviewed branches; this table records only
this completed cleanup.

## Rollout checklist

- [x] Inspect every branch for work absent from the candidate.
- [x] Preserve the previous main source under an archive ref and document its architecture.
- [x] Separate current user/developer guides from historical records.
- [x] Pass full Linux validation and Windows unit/build checks.
- [ ] Resolve Windows browser-test failures (deferred during consolidation).
- [x] Merge shared checkout into main without rewriting existing history.
- [x] Create the archival tag and retire the 17 listed branch names.

[GitHub Actions validation](https://github.com/MhmdAlTamimi/Bonsai/actions/runs/40884112890)
records the candidate's checks. Linux passed all checks, including 42 browser tests.
Windows passed unit/type/lint/format/build checks; its browser run passed 36 tests,
failed four, and skipped two. Resolution of those four failures was explicitly deferred
during consolidation. See [validation status](../development.md#validation-status).

[Approved branch retirement](https://github.com/MhmdAlTamimi/Bonsai/actions/runs/40889025313)
completed successfully. The temporary cleanup workflow was removed after verifying the
resulting branch and tag refs.
