// Tests for `src/config.ts`. Because the module reads env at LOAD time and
// throws on a missing internal token, every test uses a dynamic import
// inside an isolated scope with manipulated `process.env`. We also call
// `import()` with a cache-busting query so each case re-evaluates.

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

type ConfigShape = {
  daemonUrl: string;
  internalToken: string;
  ptahTimeoutMs: number;
};

const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Record<string, string | undefined>): void {
  // Clear the three env vars config.ts reads, then apply overrides.
  delete process.env.OPENCLAW_INTERNAL_TOKEN;
  delete process.env.OPENCLAW_DAEMON_URL;
  delete process.env.PTAH_INVOKER_TIMEOUT_MS;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function loadConfig(): Promise<ConfigShape> {
  // Cache-bust so each test re-evaluates the module-load throw/no-throw.
  const mod = await import(
    `../src/config.ts?cachebust=${Math.random()}`
  );
  return mod.config as ConfigShape;
}

describe("config.ts — env-var contract", () => {
  beforeEach(() => {
    // Reset to a clean baseline before each test.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("throws at module load when OPENCLAW_INTERNAL_TOKEN is empty", async () => {
    setEnv({ OPENCLAW_INTERNAL_TOKEN: "" });
    await assert.rejects(
      loadConfig(),
      /OPENCLAW_INTERNAL_TOKEN is required/,
      "config.ts must throw when the internal token is empty",
    );
  });

  it("throws at module load when OPENCLAW_INTERNAL_TOKEN is unset", async () => {
    setEnv({ OPENCLAW_INTERNAL_TOKEN: undefined });
    await assert.rejects(
      loadConfig(),
      /OPENCLAW_INTERNAL_TOKEN is required/,
      "config.ts must throw when the internal token is missing entirely",
    );
  });

  it("reads OPENCLAW_DAEMON_URL when set", async () => {
    setEnv({
      OPENCLAW_INTERNAL_TOKEN: "secret-token-abc",
      OPENCLAW_DAEMON_URL: "http://daemon.example:9999",
    });
    const config = await loadConfig();
    assert.equal(config.daemonUrl, "http://daemon.example:9999");
    assert.equal(config.internalToken, "secret-token-abc");
  });

  it("falls back to http://127.0.0.1:7878 when OPENCLAW_DAEMON_URL is unset", async () => {
    setEnv({ OPENCLAW_INTERNAL_TOKEN: "secret-token-abc" });
    const config = await loadConfig();
    assert.equal(config.daemonUrl, "http://127.0.0.1:7878");
  });

  it("falls back to 1_800_000ms when PTAH_INVOKER_TIMEOUT_MS is unset", async () => {
    setEnv({ OPENCLAW_INTERNAL_TOKEN: "secret-token-abc" });
    const config = await loadConfig();
    assert.equal(config.ptahTimeoutMs, 1_800_000);
  });

  it("parses PTAH_INVOKER_TIMEOUT_MS when set", async () => {
    setEnv({
      OPENCLAW_INTERNAL_TOKEN: "secret-token-abc",
      PTAH_INVOKER_TIMEOUT_MS: "30000",
    });
    const config = await loadConfig();
    assert.equal(config.ptahTimeoutMs, 30_000);
  });
});
