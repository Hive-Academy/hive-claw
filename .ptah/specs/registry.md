# Task Registry — openclaw-control

| Task ID        | Title                                                                  | Type     | Status      | Created    | Completed  |
| -------------- | ---------------------------------------------------------------------- | -------- | ----------- | ---------- | ---------- |
| TASK_2026_001  | Migrate shared-specs git repo to internal SQLite + fix dispatch loop   | FEATURE  | COMPLETE    | 2026-04-30 | 2026-05-01 |
| TASK_2026_002  | Per-agent harness composition + tool-calling Discord chat              | FEATURE  | IN PROGRESS | 2026-05-02 |            |
| TASK_2026_003  | Discord-native chat tools: read_channel_history + upload_attachment    | FEATURE  | IMPLEMENTED | 2026-05-03 |            |
| TASK_2026_004  | Strict HITL: kill the continuation loop, manual-only dispatch          | REFACTOR | CANCELLED   | 2026-05-06 | 2026-05-12 |
| TASK_2026_005  | Empty-session detection: no-progress soft-failure + dispatch budget    | BUGFIX   | CANCELLED   | 2026-05-06 | 2026-05-12 |
| TASK_2026_006  | Architecture migration to openclaw-native multi-agent                  | REFACTOR | IN PROGRESS | 2026-05-12 |            |

Notes:
- TASK_2026_004 and _005 cancelled by TASK_2026_006: both targeted the orchestration tier (continuation loop + dispatch worker) which is removed by the migration. Their implementation-plan.md files retained under .ptah/specs/TASK_2026_00{4,5}/ for historical reference. In-flight work stashed at `refs/stash@{0}` and tagged `pre-task-2026-006-cleanup`.
