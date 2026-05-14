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
