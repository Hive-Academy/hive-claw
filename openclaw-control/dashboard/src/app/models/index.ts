export type Phase =
  | 'CONTEXT'
  | 'DESCRIPTION'
  | 'PLAN'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'IMPLEMENTED'
  | 'COMPLETE'
  | 'QA_DONE'
  | 'DONE'
  | 'UNKNOWN';

export type DispatchState = 'pending' | 'taken' | 'done' | 'failed' | 'poisoned';

export interface ProjectSummary {
  slug: string;
  path: string;
  taskCount: number;
  openTaskCount: number;
  checkpointCount: number;
}

export interface ProjectRow {
  slug: string;
  name: string;
  workspace: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  project: string;
  phase: string;
  taskType?: string;
  title?: string;
  assignedAgent?: string;
  discordUserId?: string;
  channelId?: string;
  checkpointPending: boolean;
  /**
   * Lifetime dispatch count (TASK_2026_004 schema v3). Surfaced on the
   * dashboard so a runaway is impossible to miss. The daemon always returns
   * this (default 0).
   */
  dispatchCount: number;
  /**
   * Per-task spending cap (TASK_2026_005 schema v4). Default 20. When
   * `dispatchCount >= dispatchBudget`, Advance is blocked with 409.
   */
  dispatchBudget?: number;
  /**
   * Consecutive no-progress soft-failures for the current (task, phase).
   * 0 when the last dispatch made progress or no dispatch has run yet.
   */
  noProgressStreak?: number;
  updatedAt: string;
  folder: string;
}

export interface TaskDetail extends TaskSummary {
  artifacts: Record<string, string>;
}

export interface Agent {
  id: string;
  name: string;
  persona?: string;
  capabilities?: string[];
  ownerHint?: string;
  ownedHere: boolean;
  status: 'online' | 'busy' | 'offline' | 'unknown';
  lastSeen?: string;
  busyWith?: string;
}

export interface MemoryEntry {
  scope: string;
  id: string;
  files: { name: string; size: number; mtime: string; private: boolean }[];
}

export interface Dispatch {
  id: string;
  projectSlug: string;
  taskId: string;
  phase: string;
  agentId: string;
  prompt: string;
  state: DispatchState;
  failureCount: number;
  exitCode: number | null;
  durationMs: number | null;
  stderrSnippet: string | null;
  createdBy: string;
  claimedBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface TaskFileMeta {
  filename: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TaskFileBody {
  content: string;
  contentType: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface HealthStatus {
  ok: boolean;
  ts: string;
  leader: boolean;
  localAgentIds: string[];
  storage: string;
  dbVersion?: number;
  dbPath?: string;
}

export interface SessionInfo {
  sessionId: string;
  /** Openclaw agent id whose session this is (e.g. "anubis", "horus"). */
  agentId: string;
  mtime: string;
  size: number;
}

export interface SessionTail {
  session: SessionInfo;
  events: any[];
}

/**
 * Per-agent activity summary — sourced from the agent's newest session
 * JSONL. Powers the "Now: <tool> · Ns ago" indicator on the Agents page.
 */
export interface AgentActivity {
  agentId: string;
  sessionId: string | null;
  filePath: string | null;
  sessionMtime: string | null;
  lastEventTs: string | null;
  lastTool: string | null;
  lastToolAt: string | null;
  lastTextPreview: string | null;
  recentToolCounts: Record<string, number>;
  windowSize: number;
}

export interface TaskAdvanceResult {
  ok: boolean;
  projectSlug: string;
  taskId: string;
  phase: string;
  agentId: string;
  dispatchId?: string;
  inlined?: boolean;
  promptPreview: string;
}
