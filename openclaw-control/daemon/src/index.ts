import { existsSync } from 'node:fs';
import { buildApp } from './api.js';
import { startWatchers } from './watcher.js';
import { config } from './config.js';
import { ensureLocalTree } from './memory.js';
import { startContinuationLoop } from './continuation.js';
import { startBus } from './bus.js';
import { startDispatchWorker } from './dispatch.js';
import { openOnce, runMigrations, getDb } from './db/index.js';
import { initLeaderClient } from './leaderClient.js';
import { materializeAll } from './harness/materialize.js';
import { assertCommunityTier } from './harness/licenseGuard.js';
import { setDocker } from './installWorker.js';
import { createDockerAdapter } from './dockerAdapter.js';

const STALE_ENV_VARS: readonly string[] = [
  'OPENCLAW_SPECS_REPO_URL',
  'OPENCLAW_SPECS_BRANCH',
  'OPENCLAW_GIT_TOKEN',
  'OPENCLAW_GIT_USER_NAME',
  'OPENCLAW_GIT_USER_EMAIL',
  'OPENCLAW_GIT_PULL_MS',
  'OPENCLAW_SHARED_SPECS_DIR',
  'OPENCLAW_SHARED_SPECS',
];

function warnOnStaleEnv(): void {
  for (const key of STALE_ENV_VARS) {
    const val = process.env[key];
    if (val !== undefined && val !== '') {
      console.warn(
        `[boot] WARNING: env var ${key} is set but ignored — git sync was removed in TASK_2026_001. ` +
          'Specs now live in OPENCLAW_SPECS_DB_PATH (leader) or OPENCLAW_LEADER_URL (follower). ' +
          'See docs/OPENCLAW_CONTROL.md.',
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `[boot] mode=${config.leader ? 'LEADER' : 'follower'} agents=[${config.localAgentIds.join(',') || 'none'}]`,
  );
  warnOnStaleEnv();

  // TASK_2026_002 B8 — community-tier license assertion. Runs on BOTH leader
  // and follower (the env var, when set, applies to every host in the
  // cluster). The probe goes through `pingBridge()` so a host without the
  // bridge configured can't satisfy the assertion at all — that is the
  // intended fail-closed posture. No-op when the env var is unset (default).
  // Throwing here propagates to `main().catch` and exits non-zero before
  // HTTP listen, matching the existing fatal-boot pattern.
  await assertCommunityTier();

  if (config.leader) {
    // Leader owns the SQLite DB. openOnce is idempotent; runMigrations is too.
    openOnce(config.dbPath);
    runMigrations(getDb());
    console.log(`[boot] db=${config.dbPath} migrations applied`);
    // TASK_2026_002 B6: catch up per-agent ptah scope after restart. Idempotent
    // (read existing → byte-diff → rewrite only on change), so a clean run is
    // a no-op. Best-effort across personas — a single misshapen harness.yaml
    // won't keep the leader from booting (errors are logged per-agent).
    try {
      const results = await materializeAll();
      const changed = results.filter((r) => r.changed).length;
      console.log(
        `[boot] materializeAll: ${results.length} agents, ${changed} changed`,
      );
    } catch (err) {
      console.warn('[boot] materializeAll failed (non-fatal):', err);
    }
  } else {
    // Followers talk to the leader over HTTP. The leader URL was already
    // validated as non-empty in config.ts; pass it through.
    initLeaderClient(config.leaderUrl, config.internalToken);
    console.log(`[boot] follower mode — leader=${config.leaderUrl}`);
  }

  await ensureLocalTree();

  const app = buildApp();

  // Wire the install worker's docker handle (Batch 8b deferred this for
  // cutover; Batch 10 + Batch 8b-followup lands it here). Without a docker
  // socket the install pipeline cannot exec / restart the gateway, and
  // list_installed_plugins / approve return 503 with a "no docker handle"
  // structured error. That's the intended degradation for dev / non-docker
  // setups — fail closed, not crash.
  const dockerSocket = process.env.OPENCLAW_DOCKER_SOCKET ?? '/var/run/docker.sock';
  if (existsSync(dockerSocket)) {
    try {
      const gatewayHealthUrl = process.env.OPENCLAW_GATEWAY_URL
        ? `${process.env.OPENCLAW_GATEWAY_URL.replace(/\/+$/, '')}/health`
        : undefined;
      setDocker(createDockerAdapter({
        socketPath: dockerSocket,
        ...(gatewayHealthUrl ? { gatewayHealthUrl } : {}),
      }));
      app.log.info({ socket: dockerSocket }, 'install worker: docker handle wired');
    } catch (err) {
      app.log.warn({ err }, 'install worker: failed to create docker adapter; list_installed_* will 503');
    }
  } else {
    app.log.warn({ socket: dockerSocket }, 'install worker: docker socket not present; list_installed_* will 503');
  }

  await startWatchers();
  await startBus((p) => app.log.info({ handoff: p }, 'agent handoff received'));

  // Followers (and the leader, if it owns local agents too) run a dispatch
  // worker that picks up jobs assigned to their local agents.
  if (config.localAgentIds.length > 0) {
    startDispatchWorker(Number(process.env.OPENCLAW_DISPATCH_MS ?? 10_000));
  }

  // Only the leader runs the continuation loop (writes new dispatches).
  if (config.leader && process.env.OPENCLAW_DISABLE_CONTINUATION !== '1') {
    startContinuationLoop(Number(process.env.OPENCLAW_TICK_MS ?? 30_000));
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`openclaw-control daemon on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
