/**
 * harness/worktree.ts — Stage 0.5 of TASK_2026_007 (agent-as-developer).
 *
 * When the invoker is about to spawn ptah for a dispatched task and the
 * task's project is a registered github repo (i.e. `project.githubRepo` is
 * set on the canonical Project view), this module creates (or reuses) a
 * per-task git worktree under `<project.path>/.worktrees/<task-id>` on
 * branch `agent/<agent-id>/<task-id>` cut from the project's default branch.
 *
 * The invoker overrides ptah's `cwd` to that worktree path. The agent
 * lands in a clean checkout on his own branch — he can edit, run tests via
 * Bash, commit, and push without thinking about worktree mechanics.
 *
 * Failure mode: any error during worktree creation degrades to "use the
 * project root as cwd" rather than failing the dispatch. The agent loses
 * branch isolation but still completes the run; the operator gets a
 * structured warning in the dispatch log + stderr.
 *
 * Cleanup is deliberately deferred — branches and worktrees stay around
 * after task DONE so the operator can review the agent's work. A future
 * GC sweep (or a manual `git worktree remove` endpoint) reclaims space.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project } from '../projects.js';

const execFileAsync = promisify(execFile);

export interface WorktreeSetupResult {
  /** The path the invoker should pass to ptah as `cwd`. */
  cwd: string;
  /** Branch name the worktree is checked out on, or null when no worktree was set up. */
  branch: string | null;
  /** Worktree directory, or null when no worktree was set up. */
  worktreePath: string | null;
  /** Human-readable note for the dispatch log (always present). */
  note: string;
}

/**
 * Resolve the worktree path + branch for a given task. Pure (no FS).
 */
function plan(project: Project, agentId: string, taskId: string): {
  worktreePath: string;
  branch: string;
  baseBranch: string;
} {
  // Sanitize task id for use in branch / path. Task ids are already
  // alphanumeric+underscore by convention but defense-in-depth.
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const safeTask = taskId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return {
    worktreePath: path.join(project.path, '.worktrees', safeTask),
    branch: `agent/${safeAgent}/${safeTask}`,
    baseBranch: project.defaultBranch ?? 'main',
  };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isGitWorkingDir(p: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', p, 'rev-parse', '--is-inside-work-tree'],
      { timeout: 5000 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check whether the worktree at `worktreePath` is already registered with
 * the project's git repo. Cheap — runs `git worktree list --porcelain` once.
 */
async function existingWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', projectPath, 'worktree', 'list', '--porcelain'],
      { timeout: 5000 },
    );
    // Each entry begins `worktree <abs-path>`; match the resolved absolute path.
    const target = path.resolve(worktreePath);
    return stdout
      .split('\n')
      .some((line) => line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length).trim()) === target);
  } catch {
    return false;
  }
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or reuse the per-task worktree. Returns `{cwd, branch, worktreePath, note}`.
 *
 * When `project.githubRepo` is null, or when `project.path` is not a git
 * working dir, returns the project path unchanged (`branch=null,
 * worktreePath=null`) — the dispatch behaves exactly as before.
 *
 * Idempotency:
 *   - Worktree dir already registered for this task → reuse, no-op.
 *   - Worktree dir exists on disk but git doesn't know about it → log,
 *     return project path as cwd (don't try to repair — could be a stale
 *     manual mkdir).
 *   - Branch already exists → reuse it (`git worktree add <path> <branch>`
 *     without `-b`).
 *   - Branch is new → create from `project.defaultBranch ?? 'main'`
 *     (`git worktree add <path> -b <branch> <base>`).
 */
export async function setupWorktree(
  project: Project,
  agentId: string,
  taskId: string,
): Promise<WorktreeSetupResult> {
  if (!project.githubRepo) {
    return {
      cwd: project.path,
      branch: null,
      worktreePath: null,
      note: 'worktree skipped: project.githubRepo is null (non-github project)',
    };
  }

  if (!(await isGitWorkingDir(project.path))) {
    return {
      cwd: project.path,
      branch: null,
      worktreePath: null,
      note: `worktree skipped: ${project.path} is not a git working dir`,
    };
  }

  const { worktreePath, branch, baseBranch } = plan(project, agentId, taskId);

  // Already registered for this task → reuse silently.
  if (await existingWorktree(project.path, worktreePath)) {
    return {
      cwd: worktreePath,
      branch,
      worktreePath,
      note: `worktree reused at ${worktreePath} (branch ${branch})`,
    };
  }

  // Path exists but git doesn't know about it — refuse to clobber.
  if (await isDirectory(worktreePath)) {
    return {
      cwd: project.path,
      branch: null,
      worktreePath: null,
      note: `worktree skipped: ${worktreePath} exists on disk but is not a registered worktree (manual cleanup needed)`,
    };
  }

  // Make sure the parent .worktrees/ dir exists.
  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      cwd: project.path,
      branch: null,
      worktreePath: null,
      note: `worktree skipped: mkdir .worktrees/ failed: ${message}`,
    };
  }

  const reuseBranch = await branchExists(project.path, branch);
  const args = reuseBranch
    ? ['-C', project.path, 'worktree', 'add', worktreePath, branch]
    : ['-C', project.path, 'worktree', 'add', worktreePath, '-b', branch, baseBranch];

  try {
    await execFileAsync('git', args, { timeout: 30_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      cwd: project.path,
      branch: null,
      worktreePath: null,
      note: `worktree creation failed (git ${args.join(' ')}): ${message}`,
    };
  }

  return {
    cwd: worktreePath,
    branch,
    worktreePath,
    note: reuseBranch
      ? `worktree created at ${worktreePath} (reusing existing branch ${branch})`
      : `worktree created at ${worktreePath} (new branch ${branch} from ${baseBranch})`,
  };
}
