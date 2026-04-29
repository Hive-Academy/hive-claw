import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Project } from './projects.js';

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

export interface TaskSummary {
  id: string;
  project: string;
  phase: Phase;
  taskType?: string;
  title?: string;
  assignedAgent?: string;
  discordUserId?: string;
  channelId?: string;
  checkpointPending: boolean;
  updatedAt: string;
  folder: string;
}

const TASK_DIR_RE = /^TASK_\d{4}_\d{3}$/;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function detectPhase(files: Record<string, boolean>, tasksMd: string | null): Phase {
  if (files['future-enhancements.md']) return 'DONE';
  if (tasksMd) {
    const lines = tasksMd.split('\n');
    const states = lines
      .map((l) => l.match(/^\s*-\s*\[([ xX-])\]\s*\*?\*?(PENDING|IN[_\s]PROGRESS|IMPLEMENTED|COMPLETE)/i))
      .filter(Boolean) as RegExpMatchArray[];
    if (states.some((s) => /IN.PROGRESS/i.test(s[2]))) return 'IN_PROGRESS';
    if (states.length && states.every((s) => /COMPLETE/i.test(s[2]))) return 'QA_DONE';
    if (states.some((s) => /IMPLEMENTED/i.test(s[2]))) return 'IMPLEMENTED';
    if (states.some((s) => /PENDING/i.test(s[2]))) return 'PENDING';
  }
  if (files['implementation-plan.md']) return 'PLAN';
  if (files['task-description.md']) return 'DESCRIPTION';
  if (files['context.md']) return 'CONTEXT';
  return 'UNKNOWN';
}

export async function readTask(project: Project, taskId: string): Promise<TaskSummary | null> {
  const folder = path.join(project.specsDir, taskId);
  if (!(await exists(folder))) return null;

  const candidates = [
    'context.md',
    'task-description.md',
    'implementation-plan.md',
    'tasks.md',
    'future-enhancements.md',
  ];
  const files: Record<string, boolean> = {};
  for (const f of candidates) files[f] = await exists(path.join(folder, f));

  let context: any = {};
  let title: string | undefined;
  if (files['context.md']) {
    const raw = await fs.readFile(path.join(folder, 'context.md'), 'utf8');
    const parsed = matter(raw);
    context = parsed.data ?? {};
    const h1 = parsed.content.match(/^#\s+(.+)$/m);
    title = h1?.[1]?.trim();
  }

  let tasksMd: string | null = null;
  if (files['tasks.md']) tasksMd = await fs.readFile(path.join(folder, 'tasks.md'), 'utf8');

  const phase = detectPhase(files, tasksMd);
  const checkpointPending =
    phase === 'DESCRIPTION' || phase === 'PLAN' || phase === 'IMPLEMENTED';

  const stat = await fs.stat(folder);

  return {
    id: taskId,
    project: project.slug,
    folder,
    phase,
    title,
    taskType: context.task_type ?? context.type,
    assignedAgent: context.assigned_agent ?? context.agent,
    discordUserId: context.discord_user_id,
    channelId: context.channel_id,
    checkpointPending,
    updatedAt: stat.mtime.toISOString(),
  };
}

export async function listTasks(project: Project): Promise<TaskSummary[]> {
  if (!(await exists(project.specsDir))) return [];
  const entries = await fs.readdir(project.specsDir, { withFileTypes: true });
  const ids = entries.filter((e) => e.isDirectory() && TASK_DIR_RE.test(e.name)).map((e) => e.name);
  const tasks = await Promise.all(ids.map((id) => readTask(project, id)));
  return tasks.filter((t): t is TaskSummary => t !== null).sort((a, b) => b.id.localeCompare(a.id));
}

export async function readTaskArtifacts(
  project: Project,
  taskId: string,
): Promise<Record<string, string>> {
  const folder = path.join(project.specsDir, taskId);
  const out: Record<string, string> = {};
  for (const f of [
    'context.md',
    'task-description.md',
    'implementation-plan.md',
    'tasks.md',
    'future-enhancements.md',
  ]) {
    const p = path.join(folder, f);
    if (await exists(p)) out[f] = await fs.readFile(p, 'utf8');
  }
  return out;
}
