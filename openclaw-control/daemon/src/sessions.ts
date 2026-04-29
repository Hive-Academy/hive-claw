import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { config } from './config.js';

export interface SessionFile {
  projectKey: string;
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
  const entries = await fs.readdir(config.claudeProjectsRoot, { withFileTypes: true });
  const out: SessionFile[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectDir = path.join(config.claudeProjectsRoot, e.name);
    const files = await fs.readdir(projectDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(projectDir, f);
      const stat = await fs.stat(fp);
      out.push({
        projectKey: e.name,
        sessionId: f.replace(/\.jsonl$/, ''),
        filePath: fp,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export async function newestSessionForProject(projectKey: string): Promise<SessionFile | null> {
  const all = await listSessions();
  return all.find((s) => s.projectKey === projectKey) ?? null;
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
