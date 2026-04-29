import chokidar from 'chokidar';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { config } from './config.js';
import { broadcast } from './sse.js';
import { parseEvent } from './sessions.js';

const sessionOffsets = new Map<string, number>();

export async function startWatchers(): Promise<void> {
  // Specs tree (shared-specs/specs/<project>/TASK_*) — single watcher root,
  // works whether or not git sync is enabled.
  const specsWatcher = chokidar.watch(`${config.specsDir}/**`, {
    ignoreInitial: true,
    depth: 5,
  });
  specsWatcher.on('all', (event, filePath) => {
    const m = filePath.match(/(TASK_\d{4}_\d{3})/);
    if (!m) return;
    broadcast('task.updated', {
      taskId: m[1],
      event,
      file: path.basename(filePath),
    });
  });

  // Memory tree (shared-specs/memory/...)
  const memWatcher = chokidar.watch(`${config.sharedMemoryRoot}/**`, {
    ignoreInitial: true,
    depth: 4,
  });
  memWatcher.on('all', (event, filePath) => {
    broadcast('memory.updated', { event, file: path.basename(filePath) });
  });

  // Live Claude Code session JSONL files (host's, mounted read-only)
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
