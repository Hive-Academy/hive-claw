// Plugin runtime config. Reads env at module load (per arch §3.6).
//
// The internal token is REQUIRED — the daemon's Bearer-token path has no
// anonymous fallback. If the env is missing we throw immediately so the
// plugin loader logs a clear error and registers no tools (the gateway's
// `/tools/invoke list_projects` smoke test will then return 404 "Tool not
// available", which is the documented failure mode in arch §13.1).

const internalToken = process.env.OPENCLAW_INTERNAL_TOKEN ?? "";
if (!internalToken) {
  throw new Error(
    "[openclaw-control-plugin] OPENCLAW_INTERNAL_TOKEN is required " +
      "(daemon Bearer auth has no anonymous fallback for plugin callers).",
  );
}

export const config = {
  daemonUrl: process.env.OPENCLAW_DAEMON_URL ?? "http://127.0.0.1:7878",
  internalToken,
  ptahTimeoutMs: Number(process.env.PTAH_INVOKER_TIMEOUT_MS ?? 1_800_000),
};
