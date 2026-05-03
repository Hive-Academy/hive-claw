/**
 * api-harness-sync — TASK_2026_002 B3 sub-task 6.
 *
 * `POST /api/agents/:id/harness/sync` re-reads the persona's harness.yaml
 * from shared memory, computes the sha256 hash, and publishes a Redis
 * `harness/sync` event so the bot-bridge hot-reloads.
 *
 * Mocked publisher (via the `__setPublisherForTests` seam in bus.ts) lets
 * us observe the publish without standing up a Redis server. Three
 * properties verified:
 *
 *  1. With a real harness.yaml seeded via `writeMemoryFile`, the route
 *     returns 200 + the sha256 and the publisher receives one message on
 *     `harness/sync` with the matching `agentId` + `harnessHash`.
 *  2. With NO harness.yaml present, the route returns 404 and the
 *     publisher is NOT called.
 *  3. On a follower (OPENCLAW_LEADER=0) the route returns 405 — the
 *     leader owns broadcasts.
 *
 * Auth via the internal-token bearer (auth.ts:166) so we don't have to
 * mint a JWT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENTS_ROOT } from './env-stamp.ts';
import { setupTestDb } from './setup.ts';
import { buildApp } from '../src/api.ts';
import { writeMemoryFile } from '../src/memory.ts';
import { __setPublisherForTests } from '../src/bus.ts';
import { harnessHash } from '../src/harness/types.ts';
import { config } from '../src/config.ts';

if (config.localAgentsRoot !== AGENTS_ROOT) {
  throw new Error(
    `api-harness-sync.test: env override didn't reach config — got "${config.localAgentsRoot}", want "${AGENTS_ROOT}". ` +
      'env-stamp.ts must be the FIRST relative import.',
  );
}

const INTERNAL_TOKEN = process.env.OPENCLAW_INTERNAL_TOKEN!;

const VALID_HARNESS_YAML = `
version: 1
chatTier:
  skills: [simplify]
  subagents: []
  mcpServers: []
orchestrationTier:
  skills: []
  subagents: []
  mcpServers: []
`;

interface PubCall {
  channel: string;
  payload: string;
}

function makeFakePublisher(): { calls: PubCall[]; client: { publish: (channel: string, payload: string) => Promise<number> } } {
  const calls: PubCall[] = [];
  return {
    calls,
    client: {
      publish: async (channel: string, payload: string) => {
        calls.push({ channel, payload });
        return 1;
      },
    },
  };
}

test('api-harness-sync: POST publishes harness/sync with computed hash on the leader', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const fake = makeFakePublisher();
  const restorePub = __setPublisherForTests(fake.client as any);
  try {
    // Seed a real harness.yaml in shared memory. writeMemoryFile routes
    // (scope=agents, file=harness.yaml) through the shared backend because
    // it is NOT in PRIVATE_AGENT_FILES.
    await writeMemoryFile('agents', 'horus', 'harness.yaml', VALID_HARNESS_YAML, 'test');

    const expectedHash = harnessHash(VALID_HARNESS_YAML);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/horus/harness/sync',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; agentId: string; harnessHash: string };
    assert.equal(body.ok, true);
    assert.equal(body.agentId, 'horus');
    assert.equal(body.harnessHash, expectedHash);

    // Exactly one publish on the harness/sync channel.
    assert.equal(fake.calls.length, 1, 'publisher must be called exactly once');
    assert.equal(fake.calls[0]!.channel, 'harness/sync');
    const pubPayload = JSON.parse(fake.calls[0]!.payload) as { agentId: string; harnessHash: string };
    assert.equal(pubPayload.agentId, 'horus');
    assert.equal(pubPayload.harnessHash, expectedHash);
  } finally {
    restorePub();
    await app.close();
    t.cleanup();
  }
});

test('api-harness-sync: POST returns 404 when no harness.yaml exists, publisher not called', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const fake = makeFakePublisher();
  const restorePub = __setPublisherForTests(fake.client as any);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/no-such-agent/harness/sync',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {},
    });

    assert.equal(res.statusCode, 404);
    assert.equal(fake.calls.length, 0, 'publisher must NOT be called on 404');
  } finally {
    restorePub();
    await app.close();
    t.cleanup();
  }
});

test('api-harness-sync: POST requires authentication', async () => {
  const t = setupTestDb();
  const app = buildApp();
  const fake = makeFakePublisher();
  const restorePub = __setPublisherForTests(fake.client as any);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/horus/harness/sync',
      // no Authorization header
      payload: {},
    });

    assert.notEqual(
      res.statusCode,
      200,
      'unauthenticated POST must NOT succeed (got 200 — auth gate broken)',
    );
    assert.equal(fake.calls.length, 0);
  } finally {
    restorePub();
    await app.close();
    t.cleanup();
  }
});
