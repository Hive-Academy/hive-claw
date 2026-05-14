import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { config } from './config.js';

/**
 * SessionFile — one row in the dashboard's "Live sessions" page.
 *
 * Post-cutover (TASK_2026_006), sessions live under
 * `<openclawAgentsRoot>/<agentId>/sessions/<sessionId>.jsonl`. The legacy
 * `projectKey` field name is preserved as `agentId` here; the dashboard
 * column is relabeled to "Agent".
 */
export interface SessionFile {
  agentId: string;
  sessionId: string;
  filePath: string;
  size: number;
  mtime: string;
}

export interface SessionEvent {
  ts?: string;
  role?: string;
  type?: string;
  preview?: string;
  raw: any;
}

export async function listSessions(): Promise<SessionFile[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(config.openclawAgentsRoot, { withFileTypes: true });
  } catch (err) {
    // The agents root only exists once openclaw has booted at least one
    // agent. On a cold container this is ENOENT — return empty rather than
    // 500'ing the dashboard.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const out: SessionFile[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionsDir = path.join(config.openclawAgentsRoot, e.name, 'sessions');
    let files: string[];
    try {
      files = await fs.readdir(sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw err;
    }
    for (const f of files) {
      // Skip openclaw's per-session sidecar files; the dashboard wants the
      // chat transcript, not the trajectory replay.
      if (!f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl')) continue;
      const fp = path.join(sessionsDir, f);
      const stat = await fs.stat(fp);
      out.push({
        agentId: e.name,
        sessionId: f.replace(/\.jsonl$/, ''),
        filePath: fp,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * Find the newest session for a given agent. Kept under its original name
 * (`newestSessionForProject`) for `api.ts` import compatibility — the
 * "projectKey" naming is historical and the parameter is now an agent id.
 */
export async function newestSessionForProject(agentId: string): Promise<SessionFile | null> {
  const all = await listSessions();
  return all.find((s) => s.agentId === agentId) ?? null;
}

export async function tailSession(filePath: string, maxLines = 50): Promise<SessionEvent[]> {
  const lines: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(filePath, 'utf8') });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > maxLines * 4) lines.shift();
  }
  return lines
    .slice(-maxLines)
    .map((l) => parseEvent(l))
    .filter((e): e is SessionEvent => e !== null);
}

/**
 * Per-agent activity summary — used by the dashboard's Agents page to show
 * what the agent is *currently doing*, not just whether the heartbeat hit
 * recently. Reads the agent's newest session JSONL (skipping trajectory
 * sidecars), tails the last N events, and reports:
 *   - the active session id + its mtime,
 *   - the most-recent tool call (if any) and how long ago it happened,
 *   - the most-recent assistant text preview (truncated),
 *   - a histogram of tools used in the recent window.
 */
export interface AgentActivitySummary {
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

const ACTIVITY_TAIL_LINES = 80;

export async function agentActivity(agentId: string): Promise<AgentActivitySummary> {
  const empty: AgentActivitySummary = {
    agentId,
    sessionId: null,
    filePath: null,
    sessionMtime: null,
    lastEventTs: null,
    lastTool: null,
    lastToolAt: null,
    lastTextPreview: null,
    recentToolCounts: {},
    windowSize: 0,
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) return empty;

  const sessionsDir = path.join(config.openclawAgentsRoot, agentId, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return empty;
    throw err;
  }

  // Newest non-trajectory transcript wins.
  let newest: { fp: string; mtime: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith('.jsonl') || f.endsWith('.trajectory.jsonl')) continue;
    const fp = path.join(sessionsDir, f);
    const stat = await fs.stat(fp);
    if (!newest || stat.mtimeMs > newest.mtime) newest = { fp, mtime: stat.mtimeMs };
  }
  if (!newest) return empty;

  const fp = newest.fp;
  const stat = await fs.stat(fp);
  const lines: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(fp, 'utf8') });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > ACTIVITY_TAIL_LINES * 4) lines.shift();
  }
  const window = lines.slice(-ACTIVITY_TAIL_LINES);

  let lastEventTs: string | null = null;
  let lastTool: string | null = null;
  let lastToolAt: string | null = null;
  let lastTextPreview: string | null = null;
  const counts: Record<string, number> = {};

  for (const raw of window) {
    if (!raw.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const ts: string | undefined = parsed.timestamp ?? parsed.ts;
    if (typeof ts === 'string') lastEventTs = ts;

    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'tool_use' && typeof c.name === 'string') {
          counts[c.name] = (counts[c.name] ?? 0) + 1;
          lastTool = c.name;
          if (typeof ts === 'string') lastToolAt = ts;
        } else if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) {
          // Track the most-recent assistant-channel text.
          if (parsed.message?.role === 'assistant' || parsed.role === 'assistant') {
            lastTextPreview = c.text.slice(0, 200);
          }
        }
      }
    } else if (typeof content === 'string' && content.length > 0) {
      if (parsed.message?.role === 'assistant' || parsed.role === 'assistant') {
        lastTextPreview = content.slice(0, 200);
      }
    }
  }

  return {
    agentId,
    sessionId: path.basename(fp, '.jsonl'),
    filePath: fp,
    sessionMtime: stat.mtime.toISOString(),
    lastEventTs,
    lastTool,
    lastToolAt,
    lastTextPreview,
    recentToolCounts: counts,
    windowSize: window.length,
  };
}

export function parseEvent(line: string): SessionEvent | null {
  if (!line.trim()) return null;
  try {
    const raw = JSON.parse(line);
    const role = raw.message?.role ?? raw.role ?? raw.type;
    const ts = raw.timestamp ?? raw.ts;
    let preview: string | undefined;
    const content = raw.message?.content;
    if (typeof content === 'string') {
      preview = content.slice(0, 200);
    } else if (Array.isArray(content)) {
      const text = content.find((c: any) => c.type === 'text')?.text;
      const tool = content.find((c: any) => c.type === 'tool_use')?.name;
      preview = text?.slice(0, 200) ?? (tool ? `[tool: ${tool}]` : undefined);
    }
    return { ts, role, type: raw.type, preview, raw };
  } catch {
    return null;
  }
}
