import { buildApp } from './api.js';
import { startWatchers } from './watcher.js';
import { config } from './config.js';
import { ensureSharedTree } from './memory.js';
import { startContinuationLoop } from './continuation.js';
import { startBus } from './bus.js';
import { initGitSync } from './gitSync.js';
import { startDispatchWorker } from './dispatch.js';

async function main() {
  console.log(`[boot] mode=${config.leader ? 'LEADER' : 'follower'} agents=[${config.localAgentIds.join(',') || 'none'}]`);
  await initGitSync();
  await ensureSharedTree();

  const app = buildApp();
  await startWatchers();
  await startBus((p) => app.log.info({ handoff: p }, 'agent handoff received'));

  // Followers run a dispatch worker that picks up jobs assigned to their local agents
  if (config.localAgentIds.length > 0) {
    startDispatchWorker(Number(process.env.OPENCLAW_DISPATCH_MS ?? 8_000));
  }

  // Only the leader runs the continuation loop (writes new dispatches)
  if (process.env.OPENCLAW_DISABLE_CONTINUATION !== '1') {
    startContinuationLoop(Number(process.env.OPENCLAW_TICK_MS ?? 30_000));
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`openclaw-control daemon on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
