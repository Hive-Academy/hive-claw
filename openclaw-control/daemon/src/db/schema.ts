/**
 * SQLite schema definition for openclaw-control's specs.db.
 *
 * Each entry of `SCHEMA_V1` is a single CREATE statement so the migrator
 * can apply them one at a time and report which statement failed.
 *
 * 7 CREATE TABLE + 8 CREATE INDEX = 15 entries.
 *
 * The most important index here is `dispatches_unique_open`, the partial
 * UNIQUE index on (project_slug, task_id, phase) limited to OPEN states.
 * It encodes the defect-B fix: the continuation loop can no longer
 * insert two pending dispatches for the same (project, task, phase) —
 * the second INSERT either returns no row (ON CONFLICT DO NOTHING) or
 * raises a constraint error.
 *
 * See implementation-plan.md §2 lines 159-306 for the source of truth.
 *
 * Versions:
 *   v1 — initial schema. `dispatches_unique_open` covered ('pending','taken').
 *   v2 — `dispatches_unique_open` extended to ('pending','taken','poisoned')
 *        so the continuation loop cannot re-insert a fresh `pending` while a
 *        `poisoned` row exists for the same (project, task, phase). Operator
 *        recovery via `DELETE FROM dispatches WHERE state='poisoned' AND ...`
 *        (see docs/TROUBLESHOOTING.md / docs/OPERATIONS.md). This closes the
 *        runaway-loop CD2 from code-logic-review.md.
 */

export const CURRENT_VERSION = 4;

/**
 * v3 statements — additive migration introducing the `extension_install_requests`
 * table and its two supporting indexes. Backs TASK_2026_006 Batch 8b
 * (plugin/MCP self-extension feature, per amendment-1 §16.2).
 *
 * Reversibility (operator backout):
 *   DROP INDEX IF EXISTS idx_install_requests_agent;
 *   DROP INDEX IF EXISTS idx_install_requests_pending;
 *   DROP TABLE IF EXISTS extension_install_requests;
 *   DELETE FROM schema_version WHERE version = 3;
 */
/**
 * v4 statements — additive migration adding the two columns needed for the
 * agent-as-developer dispatcher worktree hook (Stage 0.5 of TASK_2026_007).
 *
 *   github_repo     — canonical "owner/name". When set, the invoker creates
 *                     a per-task git worktree under `<project.workspace>/.worktrees/<task-id>`
 *                     on branch `agent/<agent-id>/<task-id>` and overrides
 *                     the spawned ptah `cwd` to that worktree. When null,
 *                     dispatch behaves exactly as before (back-compat).
 *   default_branch  — base branch the worktree is cut from. Defaults to
 *                     `main` at the invoker layer when this column is null.
 *
 * Reversibility (operator backout):
 *   ALTER TABLE projects DROP COLUMN default_branch;
 *   ALTER TABLE projects DROP COLUMN github_repo;
 *   DELETE FROM schema_version WHERE version = 4;
 */
export const SCHEMA_V4: readonly string[] = [
  `ALTER TABLE projects ADD COLUMN github_repo TEXT`,
  `ALTER TABLE projects ADD COLUMN default_branch TEXT`,
];

export const SCHEMA_V3: readonly string[] = [
  `CREATE TABLE extension_install_requests (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     kind                TEXT NOT NULL CHECK (kind IN ('plugin', 'mcp_skill')),
     slug                TEXT NOT NULL,
     requesting_agent_id TEXT NOT NULL,
     reason              TEXT,
     status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','applied','failed')),
     operator_note       TEXT,
     install_output      TEXT,
     created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     decided_at          TEXT,
     applied_at          TEXT
   )`,

  `CREATE INDEX idx_install_requests_pending
     ON extension_install_requests(status, created_at)
     WHERE status = 'pending'`,

  `CREATE INDEX idx_install_requests_agent
     ON extension_install_requests(requesting_agent_id, created_at DESC)`,
];

export const SCHEMA_V1: readonly string[] = [
  // 1. projects
  `CREATE TABLE projects (
     slug         TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     workspace    TEXT,
     created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,

  // 2. tasks (canonical phase + checkpoint state lives here)
  `CREATE TABLE tasks (
     project_slug          TEXT NOT NULL,
     id                    TEXT NOT NULL,
     title                 TEXT,
     task_type             TEXT,
     assigned_agent        TEXT,
     discord_user_id       TEXT,
     channel_id            TEXT,
     current_phase         TEXT NOT NULL DEFAULT 'CONTEXT',
     checkpoint_pending    INTEGER NOT NULL DEFAULT 0,
     approvals_json        TEXT NOT NULL DEFAULT '{}',
     approval_log_json     TEXT NOT NULL DEFAULT '[]',
     created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     PRIMARY KEY (project_slug, id),
     FOREIGN KEY (project_slug) REFERENCES projects(slug) ON DELETE CASCADE
   )`,

  // 3. task_files (the .md blobs)
  `CREATE TABLE task_files (
     project_slug   TEXT NOT NULL,
     task_id        TEXT NOT NULL,
     filename       TEXT NOT NULL,
     content        TEXT NOT NULL,
     content_type   TEXT NOT NULL DEFAULT 'text/markdown',
     size_bytes     INTEGER NOT NULL,
     updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_by     TEXT,
     PRIMARY KEY (project_slug, task_id, filename),
     FOREIGN KEY (project_slug, task_id) REFERENCES tasks(project_slug, id) ON DELETE CASCADE
   )`,

  // 4. dispatches — the queue. State machine: pending → taken → done|failed|poisoned
  `CREATE TABLE dispatches (
     id              TEXT PRIMARY KEY,
     project_slug    TEXT NOT NULL,
     task_id         TEXT NOT NULL,
     phase           TEXT NOT NULL,
     agent_id        TEXT NOT NULL,
     prompt          TEXT NOT NULL,
     state           TEXT NOT NULL CHECK (state IN ('pending','taken','done','failed','poisoned')),
     failure_count   INTEGER NOT NULL DEFAULT 0,
     exit_code       INTEGER,
     duration_ms     INTEGER,
     stderr_snippet  TEXT,
     created_by      TEXT NOT NULL,
     claimed_by      TEXT,
     created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     claimed_at      TEXT,
     completed_at    TEXT,
     FOREIGN KEY (project_slug, task_id) REFERENCES tasks(project_slug, id) ON DELETE CASCADE
   )`,

  // 5. dispatch_log — human-readable audit trail
  `CREATE TABLE dispatch_log (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     dispatch_id  TEXT NOT NULL,
     ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     level        TEXT NOT NULL DEFAULT 'info',
     host         TEXT,
     message      TEXT NOT NULL,
     FOREIGN KEY (dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE
   )`,

  // 6. memory_files — SHARED tier only; PRIVATE_AGENT_FILES never inserted here
  `CREATE TABLE memory_files (
     scope        TEXT NOT NULL CHECK (scope IN ('agents','users','threads','projects')),
     owner_id     TEXT NOT NULL,
     filename     TEXT NOT NULL,
     content      TEXT NOT NULL,
     size_bytes   INTEGER NOT NULL,
     updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_by   TEXT,
     PRIMARY KEY (scope, owner_id, filename)
   )`,

  // 7. schema_version — single-row table bumped on each migration
  `CREATE TABLE schema_version (
     version    INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,

  // --- INDEXES ---

  // 1. fast list "all open dispatches for this machine's local agents"
  `CREATE INDEX dispatches_pending_by_agent
     ON dispatches(state, agent_id, created_at)
     WHERE state = 'pending'`,

  // 2. THE BUG-FIX-VIA-SCHEMA INDEX (defect B + CD2):
  //    partial UNIQUE on (project_slug, task_id, phase) limited to OPEN states.
  //    `poisoned` is included so the continuation tick cannot re-insert a
  //    fresh `pending` while a poisoned row blocks the lane — closing the
  //    runaway loop at the schema layer (cf. code-logic-review.md CD2).
  //    Operator recovery: DELETE FROM dispatches WHERE state='poisoned' AND ...
  `CREATE UNIQUE INDEX dispatches_unique_open
     ON dispatches(project_slug, task_id, phase)
     WHERE state IN ('pending','taken','poisoned')`,

  // 3. listing "all dispatches for this task" (dashboard task-detail view)
  `CREATE INDEX dispatches_by_task
     ON dispatches(project_slug, task_id, created_at DESC)`,

  // 4. audit/log lookup by dispatch id (for `GET /api/dispatches/:id`)
  `CREATE INDEX dispatch_log_by_dispatch
     ON dispatch_log(dispatch_id, ts)`,

  // 5. `GET /api/projects/:slug/tasks` listing — order by id descending
  `CREATE INDEX tasks_by_project
     ON tasks(project_slug, id DESC)`,

  // 6. memory listing per scope
  `CREATE INDEX memory_files_by_scope
     ON memory_files(scope, owner_id, filename)`,

  // 7. "show me every task in CONTEXT/PLAN/etc." (dashboard sidebar)
  `CREATE INDEX tasks_by_phase
     ON tasks(current_phase) WHERE current_phase != 'DONE'`,

  // 8. dispatch state index (for paginated `GET /api/dispatches?state=...`)
  `CREATE INDEX dispatches_by_state
     ON dispatches(state, created_at DESC)`,
];
