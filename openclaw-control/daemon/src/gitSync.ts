import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { config } from './config.js';
import { broadcast } from './sse.js';

const PUSH_RETRIES = 3;
let git: SimpleGit | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pulling = false;
let timer: NodeJS.Timeout | null = null;

function authedUrl(raw: string): string {
  if (!config.git.githubToken) return raw;
  if (!raw.startsWith('https://')) return raw;
  // Inject PAT as the basic-auth user. Token-only users are valid for GitHub.
  return raw.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(config.git.githubToken)}@`);
}

export async function initGitSync(): Promise<void> {
  if (!config.git.enabled) {
    console.log('[git-sync] OPENCLAW_SPECS_REPO_URL unset — running in local-only mode');
    await fs.mkdir(config.specsDir, { recursive: true });
    await fs.mkdir(config.sharedMemoryRoot, { recursive: true });
    return;
  }

  await fs.mkdir(config.sharedSpecsRoot, { recursive: true });
  const repoExists = await fs
    .access(path.join(config.sharedSpecsRoot, '.git'))
    .then(() => true)
    .catch(() => false);

  if (!repoExists) {
    console.log(`[git-sync] cloning ${config.git.repoUrl} → ${config.sharedSpecsRoot}`);
    const tmp = simpleGit();
    await tmp.clone(authedUrl(config.git.repoUrl), config.sharedSpecsRoot, [
      '--branch',
      config.git.branch,
      '--single-branch',
    ]).catch(async (err) => {
      if (String(err.message).includes('not found')) {
        console.warn('[git-sync] remote branch not found — initializing empty repo');
        await fs.mkdir(config.sharedSpecsRoot, { recursive: true });
        const empty = simpleGit(config.sharedSpecsRoot);
        await empty.init();
        await empty.checkoutLocalBranch(config.git.branch);
        await empty.addConfig('user.name', config.git.userName);
        await empty.addConfig('user.email', config.git.userEmail);
        await empty.addRemote('origin', authedUrl(config.git.repoUrl));
      } else {
        throw err;
      }
    });
  }

  git = simpleGit(config.sharedSpecsRoot);
  await git.addConfig('user.name', config.git.userName);
  await git.addConfig('user.email', config.git.userEmail);
  await git.remote(['set-url', 'origin', authedUrl(config.git.repoUrl)]).catch(() => {});

  await fs.mkdir(config.specsDir, { recursive: true });
  await fs.mkdir(config.sharedMemoryRoot, { recursive: true });

  await ensureGitignore();
  await pullOnce();
  startPullLoop();
}

async function ensureGitignore(): Promise<void> {
  const gi = path.join(config.sharedSpecsRoot, '.gitignore');
  const desired = ['.invoker/', '*.tmp', '.DS_Store', ''].join('\n');
  try {
    const cur = await fs.readFile(gi, 'utf8');
    if (cur === desired) return;
  } catch {}
  await fs.writeFile(gi, desired, 'utf8');
}

export async function pullOnce(): Promise<{ ok: boolean; pulled: number; err?: string }> {
  if (!git || !config.git.enabled) return { ok: true, pulled: 0 };
  if (pulling) return { ok: true, pulled: 0 };
  pulling = true;
  try {
    const res = await git.pull('origin', config.git.branch, ['--rebase=true', '--autostash']);
    const summary = res.summary;
    const pulled = (summary?.changes ?? 0) + (summary?.insertions ?? 0) + (summary?.deletions ?? 0);
    if (pulled > 0) broadcast('git.pulled', { pulled, ts: new Date().toISOString() });
    return { ok: true, pulled };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[git-sync] pull failed:', msg);
    broadcast('git.error', { op: 'pull', message: msg });
    return { ok: false, pulled: 0, err: msg };
  } finally {
    pulling = false;
  }
}

function startPullLoop(): void {
  if (timer) return;
  const tick = async () => {
    await pullOnce();
    timer = setTimeout(tick, config.git.pullIntervalMs);
  };
  timer = setTimeout(tick, config.git.pullIntervalMs);
}

export function stopGitSync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Serialize all writes (commit + push). Caller passes a function that performs
 * filesystem mutations within `config.sharedSpecsRoot`; we then `git add -A`,
 * commit with the supplied message, and push with rebase-on-conflict retries.
 *
 * If git sync is disabled, we just run the mutator and return — local-only mode.
 */
export async function commitAndPush(
  message: string,
  mutator: () => Promise<void>,
): Promise<{ ok: boolean; pushed: boolean; err?: string }> {
  if (!config.git.enabled) {
    await mutator();
    return { ok: true, pushed: false };
  }
  const job = writeQueue.then(async () => {
    if (!git) throw new Error('git not initialized');
    await mutator();
    const status = await git.status();
    if (status.files.length === 0) return { ok: true, pushed: false };
    await git.add(['-A']);
    await git.commit(message);
    let lastErr: string | undefined;
    for (let attempt = 0; attempt < PUSH_RETRIES; attempt++) {
      try {
        await git.push('origin', config.git.branch);
        broadcast('git.pushed', { message, ts: new Date().toISOString() });
        return { ok: true, pushed: true };
      } catch (err: any) {
        lastErr = err?.message ?? String(err);
        console.warn(`[git-sync] push attempt ${attempt + 1} failed:`, lastErr);
        try {
          await git.pull('origin', config.git.branch, ['--rebase=true', '--autostash']);
        } catch (pullErr: any) {
          lastErr = pullErr?.message ?? String(pullErr);
          break;
        }
      }
    }
    broadcast('git.error', { op: 'push', message: lastErr });
    return { ok: false, pushed: false, err: lastErr };
  });
  writeQueue = job.then(() => undefined, () => undefined);
  return job;
}

/**
 * Atomic file rename within the repo, committed and pushed. Used for dispatch
 * acquisition: rename `.dispatch/pending/<id>.json` → `.dispatch/taken/<id>.json`.
 * Returns false if the source no longer exists at commit time (someone else won).
 */
export async function atomicRenameAndPush(
  fromRel: string,
  toRel: string,
  message: string,
): Promise<boolean> {
  const result = await commitAndPush(message, async () => {
    const from = path.join(config.sharedSpecsRoot, fromRel);
    const to = path.join(config.sharedSpecsRoot, toRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const e = new Error('source-missing');
        (e as any).code = 'ENOENT';
        throw e;
      }
      throw err;
    }
  });
  return result.ok && result.pushed;
}
