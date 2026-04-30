import chokidar from 'chokidar';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { config } from './config.js';
import { broadcast } from './sse.js';
import { parseEvent } from './sessions.js';

/**
 * Per implementation-plan.md §9: the specs-tree and memory-tree FS
 * watchers are gone. Specs and shared memory now live in SQLite — there
 * is no FS to chokidar against. SSE notifications for those updates are
 * emitted directly from the daemon's write paths (TasksRepo writeFile,
 * MemoryRepo write, dispatch state transitions).
 *
 * What stays here is the host's Claude Code session JSONL watcher —
 * `~/.claude/projects/*.jsonl` files are written by the host's running
 * Claude CLI sessions and bind-mounted read-only into the container.
 * They are unrelated to the openclaw specs storage.
 */

const sessionOffsets = new Map<string, number>();

export async function startWatchers(): Promise<void> {
  // Live Claude Code session JSONL files (host's, mounted read-only).
  const sessionsWatcher = chokidar.watch(`${config.claudeProjectsRoot}/**/*.jsonl`, {
    ignoreInitial: false,
    awaitWriteFinish: false,
  });
  sessionsWatcher.on('add', (fp) => {
    sessionOffsets.set(fp, 0);
    void streamNew(fp);
  });
  sessionsWatcher.on('change', (fp) => {
    void streamNew(fp);
  });
}

async function streamNew(filePath: string): Promise<void> {
  const start = sessionOffsets.get(filePath) ?? 0;
  return new Promise((resolve) => {
    let bytes = start;
    const stream = createReadStream(filePath, { start, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      const ev = parseEvent(line);
      if (!ev) return;
      const projectKey = path.basename(path.dirname(filePath));
      const sessionId = path.basename(filePath, '.jsonl');
      broadcast('session.message', { projectKey, sessionId, event: ev });
    });
    rl.on('close', () => {
      sessionOffsets.set(filePath, bytes);
      resolve();
    });
  });
}
