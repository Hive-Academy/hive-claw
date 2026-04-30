/**
 * Barrel export for the db layer.
 *
 * Other daemon modules import everything they need from `./db/index.js`
 * (in dist) or `./db/index.ts` (under tsx). Keeping the barrel small
 * and explicit makes the public surface auditable.
 */

export { openOnce, getDb, getReadOnlyDb, closeAll } from './client.js';
export { CURRENT_VERSION, SCHEMA_V1 } from './schema.js';
export { runMigrations } from './migrations.js';
export { ProjectsRepo } from './projects.js';
export type { ProjectRow, UpsertProjectInput } from './projects.js';
export { TasksRepo, deriveCurrentPhase } from './tasks.js';
export type {
  Phase,
  TaskRow,
  TaskFile,
  TaskFileMeta,
  ApprovalLogEntry,
  InsertTaskInput,
} from './tasks.js';
export { DispatchRepo, isTerminalState } from './dispatches.js';
export type {
  Dispatch,
  DispatchState,
  InsertPendingOptions,
  MarkDoneInput,
} from './dispatches.js';
export { MemoryRepo, PRIVATE_AGENT_FILES } from './memory.js';
export type { MemoryScope, MemoryFile, MemoryFileMeta } from './memory.js';
