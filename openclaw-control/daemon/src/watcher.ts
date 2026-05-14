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
 * Post-cutover (TASK_2026_006), what stays here is the openclaw per-agent
 * session JSONL watcher. Path structure:
 *   <openclawAgentsRoot>/<agentId>/sessions/<sessionId>.jsonl
 * (the sibling `.trajectory.jsonl` is skipped — that's openclaw's replay
 * sidecar, not the chat transcript).
 */

const sessionOffsets = new Map<string, number>();

export async function startWatchers(): Promise<void> {
  const sessionsWatcher = chokidar.watch(
    `${config.openclawAgentsRoot}/*/sessions/*.jsonl`,
    {
      ignoreInitial: false,
      awaitWriteFinish: false,
    },
  );
  sessionsWatcher.on('add', (fp) => {
    if (fp.endsWith('.trajectory.jsonl')) return;
    sessionOffsets.set(fp, 0);
    void streamNew(fp);
  });
  sessionsWatcher.on('change', (fp) => {
    if (fp.endsWith('.trajectory.jsonl')) return;
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
      // <agentsRoot>/<agentId>/sessions/<sessionId>.jsonl — climb two levels
      // to recover the agent id.
      const agentId = path.basename(path.dirname(path.dirname(filePath)));
      const sessionId = path.basename(filePath, '.jsonl');
      broadcast('session.message', { agentId, sessionId, event: ev });
    });
    rl.on('close', () => {
      sessionOffsets.set(filePath, bytes);
      resolve();
    });
  });
}
