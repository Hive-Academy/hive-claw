# Tasks — TASK_2026_006 — openclaw-native multi-agent migration

**Status:** PENDING (no batches IN PROGRESS yet)
**Branch:** `ak/fix-internal-calls` (no merge to main)
**Recovery anchor:** tag `pre-task-2026-006-cleanup`
**Total batches:** 16
**Critical-path length (serial chain):** 10 batches
**Parallelization opportunities:** see Dependency graph

This tasks.md decomposes the 16-batch migration sequence (post-amendment) into concrete, executable batches. The amendment supersedes the original architecture wherever they conflict — specifically: `start_harness_setup` is **removed entirely** (not stubbed); deployment is **two compose services** (`openclaw-gateway` + `openclaw-daemon`); a **plugin/MCP self-extension** feature ships in v1 (batches 8b/8c/8d); the original Batch 12 (host-stack launchers) is **dropped** because containerized deployment supersedes it.

---

## Plan Validation Summary

**Validation Status:** PASSED WITH RISKS

### Assumptions Verified

- **openclaw v2026.4.24 fix for issue #59047** — verified by researcher (commit `cbcfdf6` matches installed build hash; closer cites our exact tag).
- **`/tools/invoke` is live and works** — researcher's B4 addendum probe returned 200 with expected shape on the running stack.
- **SQLite schema is at v4** — confirmed via daemon's `/api/health` probe; migration v5 in batch 8b is additive only.
- **`POST /api/sessions/<id>/messages` doesn't exist** — researcher confirmed; we never call it.
- **No `/advance` or `/cancel-pending` routes in current `api.ts`** — confirmed by researcher; no surgical removal needed.

### Risks Identified

| # | Risk | Severity | Mitigation (where) |
|---|------|----------|--------------------|
| 1 | Plugin tools fail to surface despite the v2026.4.24 fix (regression in our deployment path) | MED | Startup smoke test in `entrypoint-control.sh` calls `/tools/invoke list_projects`; container exits unhealthy on 404 (batch 10 acceptance) |
| 2 | Per-agent Discord routing has surprises (default agent picks up unbound messages) | MED | Each `accounts.<id>` gets a matching `bindings[]` entry; manual DM smoke test in batch 10 verifies `matchedBy=binding.account` for each bot |
| 3 | Plugin install volume layout doesn't match what `openclaw plugins install` actually writes | MED | Probe in batch 5b ("run `openclaw plugins install …` in scratch container, find new files, adjust volumes before locking compose") |
| 4 | `openclaw gateway restart` CLI behavior unverified for our version | MED | Batch 5b tests both CLI restart and `docker restart` fallback; install pipeline (batch 8b) picks CLI first with 30s timeout, falls back to docker restart |
| 5 | `invoke_ptah` long-running ptah subprocess holds chat loop indefinitely | LOW | `PTAH_INVOKER_TIMEOUT_MS` default 1800000 (30 min) + `signal: AbortSignal` plumbing; daemon timeout in batch 3 |
| 6 | Session-resume after gateway restart unverified for our exact session-store config | MED | Explicit smoke test in batch 8d: start session, restart gateway, send follow-up, confirm context survives |
| 7 | docker.sock bind exposes daemon container to host-level docker control | MED | Documented in batch 5b acceptance; production-hardening flag for follow-up review |
| 8 | Persona files bleed into a sandbox bind-mount via future config change | MED→LOW | Bind-mount unit test in batch 6 (`bind-mounts-do-not-leak-persona-paths.test.ts`) runs in CI on every PR touching compose/Dockerfile/template |
| 9 | Cross-machine handoff has no auto-notify (operator must @-mention other persona) | ACCEPTED | v1 design per arch §8.4; documented in batch 13 docs update |

### Edge Cases to Handle

- [ ] **`OPENCLAW_INTERNAL_TOKEN` missing at plugin load** → plugin throws at module load; openclaw logs but registers no tools → handled in batch 4 (config.ts throws explicitly with documented error)
- [ ] **Daemon unreachable from plugin** → each tool returns `failedTextResult` with the HTTP error message → handled in batches 4/5 (`failedTextResult` in every `execute()` catch)
- [ ] **Two install requests approved concurrently** → in-process worker has bounded concurrency = 1; second waits → handled in batch 8b
- [ ] **Install command exits non-zero** → request marked `failed`, gateway NOT restarted, SSE event `install.failed` → handled in batch 8b
- [ ] **Project slug with `..` or `/`** → plugin rejects in typebox + runtime check → handled in batches 4/5 (per arch §7.1 layer 6)
- [ ] **Old DISCORD_BOT_TOKEN still in `.env`** → no effect after batch 11 deletes the env var reference; harmless leftover → documented in batch 11

### Blockers Found

None. Architecture passed validation; the amendment resolves the only previously-open blocker (deployment mechanism).

---

## Dependency graph

```
1 (doc-rot, independent)
                                                           [serial spine →]
2 (plugin skeleton) ──► 4 (invoke_ptah stub) ──► 5 (6 CRUD tools) ──► 7 (Dockerfile)
                            ▲
3 (/api/ptah/invoke route) ─┘
                                                                          │
                                                                          ▼
                                                          5b (container split + compose)
                                                                          │
                                                                          ▼
                                                            6 (new openclaw.json.tmpl)
                                                                          │
                                                                          ▼
                                                              8 (MCP migration)
                                                                          │
                                                                          ▼
                                                  8b (install request schema + routes)
                                                                          │
                                                                          ▼
                                                           8c (plugin install tools)
                                                                          │
                                                                          ▼
                                                          8d (dashboard approval UI)
                                                                          │
                                                                          ▼
                                                                  9 (dual-write prep)
                                                                          │
                                                                          ▼
                                                        10 (CUTOVER — canary, irreversible)
                                                                          │
                                                                          ▼
                                                                11 (delete chat-tier)
                                                                          │
                                                                          ▼
                                                             13 (docs + close out)
```

**Parallelization opportunities** (can run alongside another batch):

- **Batch 1 (doc-rot)** — fully independent, fire-and-forget; runs alongside anything; even alongside batch 11 which deletes the file in question is acceptable as long as 1 lands before 11.
- **Batch 3 (`/api/ptah/invoke` daemon route)** — independent of plugin skeleton (batch 2). Can run in parallel with batches 2/4 once 2 has produced the plugin package skeleton. The hard dependency is "batch 4 needs both 2 AND 3 done."
- **Batch 8b can technically start in parallel with Batch 8** because they touch different code (daemon schema/routes vs config + mcp delete). Sequenced serially anyway because they both need cutover (batch 10) to happen after them, and the QA surface is cleaner if 8 finishes first.

Everything from batch 5b onward is **serial** — each batch builds artifacts the next batch depends on or modifies the same deployment surface.

**Critical-path length:** 2 → 4 → 5 → 7 → 5b → 6 → 8 → 8b → 8c → 8d → 9 → 10 → 11 → 13 = 14 sequential steps but the parallel `1` and `3` overlay reduces wall-clock to ~13. The "critical path length" cited in the header counts only ordering-required serial dependencies (10 — the cutover spine 5b through 10 plus the post-cutover cleanup).

---

## Batch 1 — Doc-rot fix at `daemonTools.ts:99`

**Status:** PENDING
**Depends on:** none
**Execution Mode:** `parallel:any` (independent — can run alongside any other batch)
**Recommended Executor:** backend-developer
**Complexity:** simple (<10 min)

**Files affected:**

- **MODIFY:** `openclaw-control/bot-bridge/src/tools/daemonTools.ts` — change the comment at line 99 (currently says "9 tools") to **"6 tools"** (per amendment §3.10: 7 → 6 because `start_harness_setup` is removed entirely, not stubbed).

**Notes for executor:**

- Verify the current literal at line 99 before editing — file content may have shifted by line number.
- This is purely a comment fix. **No behavioral change.**
- Per amendment, the count is **6** (`list_projects`, `list_tasks`, `get_task`, `create_task`, `approve_task`, `handoff_task`) — not 7. Do not write "7 tools."
- If the comment is in a context where stating the count is awkward (e.g. "9 active tools" with surrounding prose), prefer removing the count entirely over guessing the right number.

**Acceptance criteria:**

- [ ] `daemonTools.ts:99` no longer claims "9 tools." Either says "6 tools" or removes the count entirely.
- [ ] No other lines in the file are changed.
- [ ] `cd openclaw-control/bot-bridge && npm test` passes (existing chat-tier tests still green).
- [ ] `git diff` shows ≤2 line changes (the comment line + maybe surrounding whitespace).

**Rollback:** `git revert <commit>` — pure comment change, zero behavioral impact.

---

## Batch 2 — Plugin package skeleton (no behavior)

**Status:** PENDING
**Depends on:** none
**Execution Mode:** serial (gates batch 4 and batch 5; can run in parallel with batch 1 and batch 3)
**Recommended Executor:** backend-developer
**Complexity:** simple (1-2h)

**Files affected:**

- **CREATE:** `openclaw-control/plugin/` (new directory)
- **CREATE:** `openclaw-control/plugin/package.json` (per arch §3.2)
- **CREATE:** `openclaw-control/plugin/openclaw.plugin.json` (per arch §3.3, but **without `start_harness_setup`** anywhere)
- **CREATE:** `openclaw-control/plugin/tsconfig.json` (ESM, ES2022, outDir `dist`)
- **CREATE:** `openclaw-control/plugin/src/index.ts` — stub `definePluginEntry({ register(api) { api.logger.info("[openclaw-control-plugin] stub online — no tools registered yet"); }})`.
- **CREATE:** `openclaw-control/plugin/README.md` — one-paragraph description: what this is, build command.
- **CREATE:** `openclaw-control/plugin/.gitignore` — at minimum `node_modules/`, `dist/`.

**Notes for executor:**

- Use the exact `package.json` shape in arch §3.2: name `@openclaw-control/plugin`, `peerDependencies.openclaw: ">=2026.4.24"`, `dependencies: { undici: "^6.0.0" }`, `openclaw.extensions: ["./dist/index.js"]`.
- Do NOT add `typebox`, `discord.js`, `ioredis`, `@modelcontextprotocol/sdk`, or `gray-matter` as deps. typebox comes via `openclaw/plugin-sdk/typebox` re-export.
- `tsconfig.json` should match the existing `openclaw-control/daemon/tsconfig.json` style for consistency.
- Plugin manifest (`openclaw.plugin.json`) should list `configSchema.properties` matching arch §3.3 (daemonUrl, ptahTimeoutMs only — no `start_harness_setup`-related properties).

**Acceptance criteria:**

- [ ] `cd openclaw-control/plugin && npm install` succeeds with no errors.
- [ ] `npm run build` produces `dist/index.js` (CommonJS or ESM consistent with `package.json#type`).
- [ ] `node -e "import('./openclaw-control/plugin/dist/index.js').then(m=>console.log(typeof m.default))"` prints `"object"` or `"function"` (the `definePluginEntry` return shape).
- [ ] Files match the layout in arch §3.1 except `tools/`, `daemonClient.ts`, `config.ts`, `ptahLauncher.ts` are NOT yet created (those come in batches 4–5).
- [ ] Plugin is NOT yet loaded into openclaw — this is a build-only check.

**Rollback:** `rm -rf openclaw-control/plugin/` and revert `git add` if staged.

---

## Batch 3 — Daemon's new `POST /api/ptah/invoke` route

**Status:** PENDING
**Depends on:** none
**Execution Mode:** `parallel:2` (can run alongside batch 2; both feed batch 4)
**Recommended Executor:** backend-developer
**Complexity:** medium (2-4h)

**Files affected:**

- **MODIFY:** `openclaw-control/daemon/src/api.ts` — register the new route per arch §6.1.
- **MODIFY (read-only audit):** `openclaw-control/daemon/src/harness/ptahLauncher.ts` — confirm existing `spawnPtahForAgent` (or equivalent) is the integration point. If the function shape needs adjusting to accept an `agentId`/`sessionKey`/`timeoutMs` triple, make the change here.
- **MODIFY:** `openclaw-control/daemon/src/ptahBridge.ts` — if the existing bridge surface doesn't already accept these parameters, extend it (additive only).
- **CREATE:** `openclaw-control/daemon/test/api.ptah-invoke.test.ts` — new test file for the route.

**Notes for executor:**

- Route is **leader-only**: same redirect/405 shape as the project routes when called on a follower. Reference `api.ts` `/api/tasks` for the pattern.
- Auth: `guard` preHandler — same Bearer-token gate as other internal routes.
- Body schema per arch §6.1: `{ project, prompt, agentId?, sessionKey?, timeoutMs? }`.
- Response shape: `{ ok, exitCode, durationMs, output, stderr? }`.
- `timeoutMs` is **bounded** by daemon's `PTAH_INVOKER_TIMEOUT_MS` env (default 1_800_000ms = 30min); reject requests that exceed it (400).
- 404 on unknown project slug (lookup via `storage.readProject(slug)`).
- 400 on missing/invalid body (project or prompt is empty string, fails string-min-length, etc).

**Acceptance criteria:**

- [ ] `POST /api/ptah/invoke` registered in `api.ts`; route lists in `npm test`-discovered surface.
- [ ] Unit test: 401 on missing/invalid Bearer.
- [ ] Unit test: 400 on missing `project` or `prompt`.
- [ ] Unit test: 404 on unknown project slug.
- [ ] Unit test: happy-path 200 with mocked `ptahLauncher`/`ptahBridge` — confirms output is wrapped in the documented response envelope.
- [ ] Unit test: timeout-exceeded path returns `{ok:false, exitCode:null, …}` with a non-empty `stderr`.
- [ ] Existing daemon tests still pass (`cd openclaw-control/daemon && npm test`).
- [ ] **No caller yet** — route is dead-code from the plugin's perspective until batch 4 lands.

**Rollback:** `git revert <commit>` — additive route, no behavior depends on it yet.

---

## Batch 4 — Plugin: `invoke_ptah` tool (stub form with real daemon call)

**Status:** PENDING
**Depends on:** Batch 2 (plugin skeleton), Batch 3 (daemon route)
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (3-5h)

**Files affected:**

- **CREATE:** `openclaw-control/plugin/src/config.ts` (per arch §3.6 — reads `OPENCLAW_INTERNAL_TOKEN`, `OPENCLAW_DAEMON_URL`, `PTAH_INVOKER_TIMEOUT_MS`; throws at module load if internal token missing).
- **CREATE:** `openclaw-control/plugin/src/daemonClient.ts` — minimal version with **only** the `invokePtah(body)` method (full CRUD methods land in batch 5).
- **CREATE:** `openclaw-control/plugin/src/ptahLauncher.ts` (per arch §3.8 — calls `daemon.invokePtah(...)` and unwraps).
- **CREATE:** `openclaw-control/plugin/src/tools/invokePtah.ts` (per arch §3.9 — typebox params, `failedTextResult` on error, `textResult` on success).
- **MODIFY:** `openclaw-control/plugin/src/index.ts` — register `invokePtahFactory` (drop the stub-only logger line).
- **CREATE:** `openclaw-control/plugin/test/config.test.ts` — env-var fallback + missing-token throw.
- **CREATE:** `openclaw-control/plugin/test/tools.invokePtah.test.ts` — param schema validation + daemon HTTP stub round-trip.

**Notes for executor:**

- Per arch §7.1 layer 6: add **runtime input validation** at start of `invokePtah.execute`: reject `project` containing `..`, `/`, `\`, or non-ASCII control chars (typebox `minLength: 1` catches empty but not path traversal).
- `daemonClient.ts` should NOT yet include: `emitSseHint`, `readHarnessYaml`, `readDiscordJson`, `readAgentIdentity`, `tickContinuation` — these are explicit DROPs in arch §3.7.
- Use `import { Type } from "openclaw/plugin-sdk/typebox"` per arch §3.2 (no direct typebox dep).
- Plugin still not loaded into openclaw at runtime (deployment switch is batch 10).

**Acceptance criteria:**

- [ ] `npm run build` in `openclaw-control/plugin/` succeeds.
- [ ] `npm test` in `openclaw-control/plugin/` passes:
  - [ ] config.test.ts: throws when `OPENCLAW_INTERNAL_TOKEN=""`.
  - [ ] config.test.ts: reads `OPENCLAW_DAEMON_URL` with fallback to `http://127.0.0.1:7878`.
  - [ ] tools.invokePtah.test.ts: rejects `project=".."` and `project="a/b"` with `failedTextResult` (no daemon call).
  - [ ] tools.invokePtah.test.ts: happy-path stubs daemon HTTP, asserts `textResult(output, {status:"ok", durationMs, exitCode})`.
  - [ ] tools.invokePtah.test.ts: daemon HTTP 500 path returns `failedTextResult`.
- [ ] No mention of `start_harness_setup` anywhere in the plugin's src/ tree.
- [ ] grep for `local-memory`, `.claude`, `.ptah` in `openclaw-control/plugin/src/` returns ZERO hits (per arch §7.4 rule 3).

**Rollback:** `git revert <commit>`. Daemon route from batch 3 stays — still no caller, still harmless.

---

## Batch 5 — Plugin: 6 daemon-CRUD tools

**Status:** PENDING
**Depends on:** Batch 4
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (4-6h)

**Files affected:**

- **CREATE:** `openclaw-control/plugin/src/tools/daemonCrud.ts` — six tool factories: `listProjectsFactory`, `listTasksFactory`, `getTaskFactory`, `createTaskFactory`, `approveTaskFactory`, `handoffTaskFactory`. **NO `startHarnessSetupFactory`** (amendment §3.10).
- **MODIFY:** `openclaw-control/plugin/src/daemonClient.ts` — add the full CRUD method surface per arch §3.7 (project-files helpers, listProjects, listAgents, listTasks, getTask, createTask, approve, handoff, approveTask, handoffTask, readMemory, readProjectFile, listProjectFiles, writeProjectFile).
- **MODIFY:** `openclaw-control/plugin/src/index.ts` — register all 6 CRUD factories alongside `invoke_ptah`. Update the logger message to say "registered 7 tools (invoke_ptah + 6 daemon CRUD)."
- **CREATE:** `openclaw-control/plugin/test/tools.daemonCrud.test.ts` — unit tests per tool.
- **CREATE:** `openclaw-control/plugin/test/smoke.plugin.test.ts` — integration: `register()` emits 7 `registerTool` calls.

**Notes for executor:**

- Port from `openclaw-control/bot-bridge/src/tools/daemonTools.ts:104-348` but adapt context fields per arch §3.10:
  - `ctx.userId` → `ctx.requesterSenderId`
  - `ctx.channelId` → `ctx.messageChannel`
  - (Also available: `ctx.agentId`, `ctx.sessionKey`, `ctx.agentAccountId`.)
- Return shape: every tool returns `AgentToolResult` via `textResult` or `failedTextResult`. NO raw strings.
- **Do NOT port** `tick_continuation` or `dispatch_orchestration_task` — they were removed in TASK_2026_004 already.
- **Do NOT port** `start_harness_setup` — removed entirely per amendment.
- Add per-tool input validation matching arch §7.1 layer 6:
  - `project`: reject `..`, `/`, `\`, non-ASCII control chars.
  - `taskId`: reject anything not matching `^TASK_\d{4}_\d{3}$` (existing daemon validator pattern).
  - `description`, `prompt`, `reason`: reject empty after trim; cap at 50_000 chars to prevent abusive payloads.

**Acceptance criteria:**

- [ ] `npm test` in `openclaw-control/plugin/`:
  - [ ] tools.daemonCrud.test.ts: 6 tests, one per tool — each stubs daemon HTTP and asserts the `textResult` shape on success and `failedTextResult` shape on daemon error.
  - [ ] tools.daemonCrud.test.ts: input-validation tests for each tool's path-traversal + empty-string rejection.
  - [ ] smoke.plugin.test.ts: instantiates the plugin's `register` with a mock api, asserts exactly 7 `registerTool` calls with names `invoke_ptah`, `list_projects`, `list_tasks`, `get_task`, `create_task`, `approve_task`, `handoff_task`.
  - [ ] smoke.plugin.test.ts: asserts `start_harness_setup` is NOT registered.
- [ ] `npm run build` succeeds; `dist/index.js` exists.
- [ ] Existing tests (config.test.ts, tools.invokePtah.test.ts) still pass.

**Rollback:** `git revert <commit>`. The plugin's tool surface reverts to "just `invoke_ptah`" from batch 4 — still not loaded by openclaw.

---

## Batch 5b — Container split + compose rewrite (NEW from amendment)

**Status:** PENDING
**Depends on:** Batch 5 (plugin must build into a `dist/index.js` artifact for the Dockerfile to COPY)
**Execution Mode:** serial
**Recommended Executor:** devops-engineer
**Complexity:** complex (>8h — includes probing volume layout for `openclaw plugins install`)

**Files affected:**

- **MODIFY:** `docker-compose.yml` — split into three services (`openclaw-gateway`, `openclaw-daemon`, `openclaw-redis`) per amendment §9.1.
- **MODIFY:** `Dockerfile` — confirm same image works for both `openclaw gateway` and `node daemon/dist/index.js` `command:` overrides; build stages for daemon dist and plugin dist must both be present in the runtime image. Drop the `bot-builder` stage (renamed `plugin-builder` in batch 7; this batch just defers it).
- **MODIFY:** `entrypoint.sh` — handle the gateway-only path (when `command:` is `openclaw gateway`).
- **CREATE:** `entrypoint-daemon.sh` — separate entrypoint for the daemon container (or extend `entrypoint-control.sh` with a mode switch).
- **CREATE:** `docs/OPERATIONS.md` patch (append a section) — document the docker.sock bind-mount, restart mechanism, security implication.
- **CREATE:** `scripts/probe-plugin-install-paths.sh` — one-off probe script that runs `openclaw plugins install npm:@openclaw/web-search` in a scratch container and dumps `find /home/agent/.openclaw -newer /tmp/probe-start` for verification.

**Notes for executor:**

- The two compose services use the **same image** (`openclaw-local:latest`); they differ only in `command:`. Confirm by `docker compose config` showing identical `image:` for both.
- Volume layout per amendment §9.1: `openclaw-state`, `openclaw-extensions`, `openclaw-skills`, `openclaw-data` (named volumes, plus three host bind-mounts for `~/.config/gh:ro`, `~/.ptah` rw, `/var/run/docker.sock`).
- **Run the probe script before locking the compose volumes:** `bash scripts/probe-plugin-install-paths.sh` and confirm the install paths match `/home/agent/.openclaw/extensions/...` and `/home/agent/.openclaw/skills/...`. If openclaw writes to a different path (e.g. `/var/lib/openclaw/...`), adjust the named volume mount targets BEFORE proceeding.
- **Restart mechanism (amendment §9.3):** test both `docker exec openclaw-gateway openclaw gateway restart` (preferred) and `docker restart openclaw-gateway` (fallback). Document the timing of each. The CLI restart should drain in-flight tool calls gracefully (<30s); the docker restart is SIGKILL after a grace period.
- Add `host.docker.internal:host-gateway` to `extra_hosts:` of `openclaw-gateway` so the plugin can reach the host-side ptah-bridge.
- Add `healthcheck:` to `openclaw-gateway` and `openclaw-daemon` (curl `/health` on each respective port).
- `depends_on` chain: gateway depends on redis healthy; daemon depends on gateway started.

**Acceptance criteria:**

- [ ] `docker compose config` parses without errors.
- [ ] `docker compose build` succeeds; resulting image contains both `openclaw` binary and `node /opt/openclaw-control/daemon/dist/index.js`.
- [ ] `docker compose up -d` brings up three containers, all healthy within 60s.
- [ ] From host: `curl http://127.0.0.1:18789/health` returns 200 (gateway).
- [ ] From host: `curl http://127.0.0.1:7878/api/health` returns `{"ok":true,"leader":true,...}`.
- [ ] `docker exec openclaw-daemon docker ps` succeeds (docker.sock bind works).
- [ ] `docker exec openclaw-gateway openclaw gateway restart` either succeeds OR fails cleanly with a non-zero exit code AND a documented fallback to `docker restart openclaw-gateway` works (recorded in OPERATIONS.md).
- [ ] Probe script run; volume paths in compose file match the actual install output of `openclaw plugins install`.
- [ ] No persona-private paths (`local-memory`, `.claude`, `.ptah` parent without explicit allowlist) appear in any bind-mount line. (`bind-mounts-do-not-leak-persona-paths.test.ts` from batch 6 will lock this in — until then, manual grep.)
- [ ] `docker compose down` followed by `docker compose up -d` preserves all 4 named volumes' contents (verify by writing a marker file to `/home/agent/.openclaw/extensions/` and confirming it survives).

**Rollback:** Revert all the touched files via `git revert <commit>`. `docker compose down -v` is destructive (deletes the named volumes) — DO NOT run with `-v` during rollback unless the operator confirms a clean restart from scratch is desired. Document in the commit message.

---

## Batch 6 — New `config/openclaw.json.tmpl`

**Status:** PENDING
**Depends on:** Batch 5b (compose layout must be finalized so volume paths in template match)
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (3-5h, mostly verification)

**Files affected:**

- **REWRITE:** `config/openclaw.json.tmpl` per arch §4.2 — agents.list, channels.discord.accounts per-persona, bindings[], mcp.servers.gh, agents.defaults.tools.fs.workspaceOnly: true.
- **MODIFY:** `entrypoint.sh` — add `DISCORD_TOKEN_ANUBIS`, `DISCORD_TOKEN_HORUS`, `GITHUB_TOKEN` to envsubst variable list. Remove the `DISCORD_BOT_TOKEN` default-set if present (env still appears in the .env for transitional compatibility — actually removed in batch 11).
- **MODIFY:** `docs/CONFIGURATION.md` — document the new env vars and the two-persona default config; mark `DISCORD_BOT_TOKEN` as deprecated (to be removed in batch 11).
- **CREATE:** `.env.example` (if absent) or **MODIFY:** existing one to include the new tokens.
- **CREATE:** `openclaw-control/daemon/test/security/bind-mounts-do-not-leak-persona-paths.test.ts` per arch §7.5.

**Notes for executor:**

- Per amendment decision #3: MCP scope is **config-wide**. Default config keeps the single `gh` server visible to all agents; no `tools.deny` per-persona in v1.
- The bind-mount test scans `docker-compose.yml` and `config/openclaw.json.tmpl`. Both must NOT include `local-memory`, `.claude`, or `.ptah` in any `binds:`/`volumes:` line (the test parser is permissive — see arch §7.5).
- `workspace:` per agent is `/home/agent/.openclaw/workspace/<id>` — confirm openclaw creates this on session boot or pre-create in entrypoint.
- The two personas in `agents.list` are `anubis` (with `default: true`) and `horus`. For single-machine setups where only one persona is bound locally (per `OPENCLAW_LOCAL_AGENT_IDS`), the inactive persona's binding still exists in the JSON but its Discord account token will be missing from `.env` → openclaw won't connect that bot. This is the intended degradation per arch §8.1.
- Render the template with stub env vars (`envsubst < config/openclaw.json.tmpl`) and pipe to `jq .` to confirm valid JSON.

**Acceptance criteria:**

- [ ] `envsubst < config/openclaw.json.tmpl | jq .agents.defaults.tools.fs.workspaceOnly` outputs `true`.
- [ ] `envsubst < config/openclaw.json.tmpl | jq '.agents.list | length'` outputs `2`.
- [ ] `envsubst < config/openclaw.json.tmpl | jq '.bindings | length'` outputs `2`.
- [ ] `envsubst < config/openclaw.json.tmpl | jq '.channels.discord.accounts | keys'` outputs `["anubis", "horus"]`.
- [ ] `envsubst < config/openclaw.json.tmpl | jq '.mcp.servers.gh.command'` outputs `"npx"`.
- [ ] `bind-mounts-do-not-leak-persona-paths.test.ts` passes; scans both `docker-compose.yml` and the new template.
- [ ] The bind-mount test ALSO validates `agents.defaults.tools.fs.workspaceOnly === true` per arch §7.5.
- [ ] Existing daemon tests still pass.
- [ ] The OLD `openclaw.json` running in the gateway container is NOT yet replaced — this batch ships a template change only. The gateway continues running on the old config until batch 10.

**Rollback:** `git revert <commit>`. The running gateway is unaffected because this is a template-only change.

---

## Batch 7 — Plugin Dockerfile integration

**Status:** PENDING
**Depends on:** Batch 5 (plugin must build) AND Batch 5b (compose split must be in place)
**Execution Mode:** serial
**Recommended Executor:** devops-engineer
**Complexity:** medium (2-4h)

**Files affected:**

- **MODIFY:** `Dockerfile` — add a `plugin-builder` stage (per arch §9.4) that compiles `openclaw-control/plugin/`. In the runtime stage, COPY `/build/plugin/dist` → `/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/` and COPY the plugin `package.json` alongside.
- **MODIFY:** `entrypoint-control.sh` (or `entrypoint-daemon.sh` from batch 5b) — drop the `node /opt/openclaw-control/bot-bridge/dist/index.js` spawn line. Only the daemon (and dashboard) remain in the daemon container.
- **MODIFY:** `.dockerignore` — ensure `openclaw-control/plugin/node_modules` and `openclaw-control/plugin/dist` are excluded from the build context (the multi-stage `npm ci + build` produces them fresh inside the builder stage).

**Notes for executor:**

- Bundled-extension layout (research §B5 Option A) is the canonical choice. No `plugins.allow` list, no `plugins.load.paths` — openclaw auto-discovers `dist/extensions/*` directories with an `index.js`.
- The plugin's `package.json` must be present **alongside** `index.js` in `/usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/` so openclaw's plugin loader can read `openclaw.extensions` and `peerDependencies`.
- The bot-bridge package itself is still on disk at this point — batch 11 deletes it.
- After this batch, openclaw still doesn't see the plugin until the gateway container restarts with the new image. Batch 10 is the cutover that triggers that restart.

**Acceptance criteria:**

- [ ] `docker compose build` succeeds.
- [ ] `docker run --rm --entrypoint sh openclaw-local:latest -c "ls /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/index.js"` succeeds (file exists, non-zero size).
- [ ] `docker run --rm --entrypoint sh openclaw-local:latest -c "cat /usr/lib/node_modules/openclaw/dist/extensions/openclaw-control-plugin/package.json | jq .name"` outputs `"@openclaw-control/plugin"`.
- [ ] `entrypoint-control.sh` (or the daemon entrypoint) no longer spawns the bot-bridge process.
- [ ] `docker compose up -d` succeeds and the OLD bot-bridge (PID 2598 on host) is NOT inside any container (the host process is still running — this batch hasn't touched the host).
- [ ] `bind-mounts-do-not-leak-persona-paths.test.ts` still passes (Dockerfile bind-mount lines, if any, are scanned).

**Rollback:** `git revert <commit>`. Rebuild image without the new Dockerfile stage. The plugin artifact is no longer copied; gateway continues running the old config from batch 5b.

---

## Batch 8 — MCP migration

**Status:** PENDING
**Depends on:** Batch 6 (the new template must include the `mcp.servers.gh` block before we delete the bot-bridge MCP code)
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (3-5h)

**Files affected:**

- **DELETE:** `openclaw-control/bot-bridge/src/mcp/mcpManager.ts`.
- **DELETE:** `openclaw-control/bot-bridge/src/tools/mcpTools.ts`.
- **MODIFY:** `shared-specs/memory/agents/anubis/harness.yaml` — remove the `chatTier.mcpServers` block (which currently lists `gh`).
- **MODIFY (if present):** `shared-specs/memory/agents/horus/harness.yaml` — same (horus may or may not have an mcpServers block; remove if present).
- **DELETE:** any bot-bridge tests that import `mcpManager` or `mcpTools` (e.g. `bot-bridge/test/mcp.test.ts` per arch §13.5).
- **VERIFY:** `config/openclaw.json.tmpl` already has `mcp.servers.gh` (from batch 6) — no change here, just confirmation.

**Notes for executor:**

- This batch deletes ~870 lines of bot-bridge code (mcpManager 808 + mcpTools 65 + tests).
- The OLD bot-bridge will fail to compile after this batch — that's fine; the OLD bot-bridge process running on host is unaffected because it doesn't re-import on the fly. It's a "dead code that we're deleting" change.
- The new openclaw template's `mcp.servers.gh` block is already in place from batch 6 — the gateway will start using it after batch 10's restart.
- `daemon/src/harness/types.ts` keeps `chatTier.mcpServers` in the schema (per arch §5.3 Phase 3 cleanup) so daemon `materialize.ts` doesn't break on existing harness.yaml files that haven't been re-rendered. Field becomes informational-only.

**Acceptance criteria:**

- [ ] `find openclaw-control/bot-bridge/src -name "mcpManager.ts" -o -name "mcpTools.ts"` returns no results.
- [ ] `grep -r "chatTier.*mcpServers" shared-specs/memory/agents/` returns no results (block deleted in all persona yamls).
- [ ] `cd openclaw-control/daemon && npm test` passes (daemon's `materialize.ts` still parses harness.yaml).
- [ ] **OLD bot-bridge compile is now broken** — this is expected. Note in the commit message: "bot-bridge no longer compiles; OLD process keeps running until cutover (batch 10)."
- [ ] `bind-mounts-do-not-leak-persona-paths.test.ts` still passes.
- [ ] (Smoke, requires running gateway with new config — defer to batch 10 verification): once the gateway is on the new config, `curl /tools/invoke list_projects` round-trip still works AND `tool_search` lists at least one `gh__*` tool.

**Rollback:** `git revert <commit>` — restores the bot-bridge MCP code and the harness.yaml block. Verify OLD bot-bridge still compiles (`cd openclaw-control/bot-bridge && npm run build`) after revert.

---

## Batch 8b — Extension install request schema + daemon routes (NEW from amendment)

**Status:** PENDING
**Depends on:** Batch 8
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** complex (>8h)

**Files affected:**

- **CREATE:** `openclaw-control/daemon/src/db/migrations/005_extension_install_requests.sql` (or follow the existing migrations file naming convention; check `openclaw-control/daemon/src/db/migrations.ts` for the pattern) — adds the `extension_install_requests` table per amendment §16.2.
- **CREATE:** `openclaw-control/daemon/src/db/installRequests.ts` — repository layer (`createRequest`, `getRequest`, `listPending`, `markApproved`, `markRejected`, `markApplied`, `markFailed`, `listInstalled`).
- **CREATE:** `openclaw-control/daemon/src/installWorker.ts` — in-process serial worker (bounded concurrency = 1) per amendment §16.5.
- **MODIFY:** `openclaw-control/daemon/src/api.ts` — add the 6 new routes per amendment §16.3 (`POST /api/extensions/install-requests`, `GET /api/extensions/install-requests/pending`, `GET /api/extensions/install-requests/:id`, `POST /api/extensions/install-requests/:id/approve`, `POST /api/extensions/install-requests/:id/reject`, `GET /api/extensions/installed`).
- **MODIFY:** `openclaw-control/daemon/src/bus.ts` — add SSE topics `installs.*` (`install.requested`, `install.approved`, `install.rejected`, `install.applied`, `install.failed`).
- **MODIFY:** `openclaw-control/daemon/src/index.ts` (or wherever the SSE bus is wired) — register the new topic.
- **CREATE:** `openclaw-control/daemon/test/api.extensions.test.ts` — route tests.
- **CREATE:** `openclaw-control/daemon/test/installWorker.test.ts` — worker tests with mocked docker.

**Notes for executor:**

- Schema migration is **additive only** — no destructive changes to existing tables. v4 → v5 must be reversible via DROP TABLE.
- The install worker uses `dockerode` (npm package) — add as a daemon dependency. Wraps `docker exec` and `docker restart` calls.
- Worker reads the daemon's docker.sock bind from `/var/run/docker.sock` (set up in batch 5b).
- Worker behavior on restart (per amendment §16.5):
  1. `docker exec openclaw-gateway openclaw <plugins|skills> install <slug>` — capture stdout+stderr.
  2. If exit 0: try `docker exec openclaw-gateway openclaw gateway restart`; if that returns non-zero OR hangs >30s, fall back to `docker restart openclaw-gateway`.
  3. Wait up to 30s for `curl http://127.0.0.1:18789/health` to return 200.
  4. UPDATE status; emit SSE.
- Auth on routes per amendment §16.3:
  - `POST /api/extensions/install-requests` → Bearer (internal — plugin tool calls this).
  - GETs → Cookie (operator dashboard) OR Bearer (plugin's `list_installed_plugins` tool).
  - `POST /:id/approve` and `/:id/reject` → Cookie ONLY (operator decision; plugin must NOT bypass).
- The `apply on next restart` flag from amendment §16.6: the entrypoint script should run `docker exec openclaw-gateway openclaw plugins install <slug>` for each `status='approved' AND applied_at IS NULL` row before openclaw starts. This is a startup hook in `entrypoint.sh` of the gateway container.

**Acceptance criteria:**

- [ ] Schema migration v5 applies cleanly on a fresh DB; running it twice is a no-op.
- [ ] All 6 routes registered and respond with correct status codes:
  - [ ] `POST /api/extensions/install-requests` 201 with body `{requestId, status:"pending"}`; emits SSE `install.requested`.
  - [ ] `GET /api/extensions/install-requests/pending` returns array of pending rows.
  - [ ] `POST /api/extensions/install-requests/:id/approve` triggers the worker; emits SSE `install.approved` synchronously; eventually emits `install.applied` or `install.failed`.
  - [ ] `POST /api/extensions/install-requests/:id/approve` with cookie=missing → 401.
  - [ ] `POST /api/extensions/install-requests/:id/approve` on already-applied request → 409 conflict.
  - [ ] `POST /api/extensions/install-requests/:id/reject` updates status.
  - [ ] `GET /api/extensions/installed` returns the installed-set (mocked via `docker exec openclaw plugins list`).
- [ ] installWorker.test.ts:
  - [ ] Concurrent approval of two requests → second waits for first; queue order preserved.
  - [ ] Non-zero exit from `openclaw plugins install` → status='failed', NO restart triggered, install_output captured.
  - [ ] CLI restart returning non-zero → fallback to `docker restart` succeeds.
- [ ] `cd openclaw-control/daemon && npm test` passes including new tests.

**Rollback:** `git revert <commit>`. The migration v5 must also be backed out: `DROP TABLE extension_install_requests; DELETE FROM schema_migrations WHERE version=5;`. Document this SQL in the commit message and in the rollback section of the PR.

---

## Batch 8c — Plugin tools for install requests (NEW from amendment)

**Status:** PENDING
**Depends on:** Batch 8b
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (3-5h)

**Files affected:**

- **CREATE:** `openclaw-control/plugin/src/tools/extensions.ts` — 5 new tool factories per amendment §16.4: `requestPluginInstallFactory`, `requestMcpSkillInstallFactory`, `listInstalledPluginsFactory`, `listInstalledMcpSkillsFactory`, `searchClawhubFactory`.
- **MODIFY:** `openclaw-control/plugin/src/daemonClient.ts` — add methods `requestExtensionInstall(body)`, `listInstalled(kind)`, `searchClawhub(query, kind?)`.
- **MODIFY:** `openclaw-control/plugin/src/index.ts` — register the 5 new factories. Update logger: "registered 12 tools (invoke_ptah + 6 daemon CRUD + 5 install/clawhub)."
- **CREATE:** `openclaw-control/plugin/test/tools.extensions.test.ts` — unit tests for the 5 new tools.

**Notes for executor:**

- All 5 tools call only daemon routes — none shells out to docker or openclaw directly. The daemon owns the docker-control privilege via its docker.sock bind.
- `search_clawhub` per amendment §16.4: first try a daemon-side wrapper (preferred) that calls `openclaw plugins search` inside the gateway container. If that's not yet implemented in batch 8b, the tool returns `failedTextResult` with a "not yet available" message. **Mark with a TODO comment in code and an acceptance criterion** that captures the gap if the daemon route is skipped.
- The two `request_*_install` tools per amendment §16.4 take `slug` (string) and optional `reason` (string). On success they return a markdown summary including `requestId` and `status:'pending'`. Both call `daemonClient.requestExtensionInstall({ kind, slug, requestingAgentId: ctx.agentId, reason })`.
- The `list_installed_*` tools take no params and return markdown tables.
- All 5 tools respect the existing input validation pattern (no path traversal in slug; cap reason length).

**Acceptance criteria:**

- [ ] tools.extensions.test.ts:
  - [ ] `request_plugin_install` happy path: returns markdown with `requestId` and pending status.
  - [ ] `request_plugin_install` rejects empty slug.
  - [ ] `request_mcp_skill_install` happy path.
  - [ ] `list_installed_plugins` formats the daemon response as a markdown table.
  - [ ] `list_installed_mcp_skills` formats correctly.
  - [ ] `search_clawhub`: happy path (daemon route mocked) OR documents the "not yet available" failure mode.
- [ ] smoke.plugin.test.ts updated to assert **12 `registerTool` calls** with the new names included.
- [ ] `npm run build` succeeds.

**Rollback:** `git revert <commit>`. Plugin's tool surface reverts to 7 tools (batch 5 state). Daemon routes from batch 8b stay — no caller, but they continue to function.

---

## Batch 8d — Dashboard approval UI (NEW from amendment)

**Status:** PENDING
**Depends on:** Batches 8b (routes) AND 8c (plugin tools — so the operator has something meaningful to approve in end-to-end testing)
**Execution Mode:** serial
**Recommended Executor:** frontend-developer
**Complexity:** complex (>8h)

**Files affected:**

- **CREATE:** `openclaw-control/dashboard/src/app/pages/extensions/` (new feature directory in whatever framework the dashboard uses — check existing pages for the pattern, likely Angular based on the available skills).
- **CREATE:** `extensions-page.component.ts/html/scss` — main page with two tabs.
- **CREATE:** `pending-approvals.component.ts` — list of pending requests with Approve & Apply Now / Approve, Apply on next restart / Reject buttons + note textarea.
- **CREATE:** `installed-inventory.component.ts` — list of installed plugins + decision history audit.
- **CREATE:** `extensions.service.ts` — HTTP client for the 6 routes + SSE subscriber for `installs.*`.
- **MODIFY:** dashboard's main router/nav — add the new page; badge count on nav for pending requests.
- **CREATE:** `openclaw-control/dashboard/test/extensions.e2e.spec.ts` or equivalent — e2e/integration test for the approval flow.

**Notes for executor:**

- UX shape per amendment §16.6 — two tabs, badge count, three buttons per request, note textarea.
- "Approve & Apply now" → `POST /:id/approve` with `{note}` body; show "Installing… estimated 10-30s downtime" toast; subscribe to SSE for `install.applied` or `install.failed` to update the toast.
- "Approve, apply on next restart" → `POST /:id/approve` with `{note, deferApply: true}` (need to extend the daemon route in batch 8b OR encode this client-side by not triggering the worker — coordinate with batch 8b implementor; safer to coordinate as a small addition to 8b's route body schema).
- "Reject" → `POST /:id/reject` with `{note}`.
- SSE subscription `/api/stream?topics=installs` — auto-update the page on incoming events without manual refresh.

**Session-resume smoke test (CRITICAL — per amendment §16.7):**

This is the only place we verify that openclaw's session store survives a gateway restart. The dashboard test should:

1. Start an openclaw chat session (via `/tools/invoke sessions_*` or by sending a real Discord message; depending on test setup).
2. Trigger `docker restart openclaw-gateway` (test fixture, not user action).
3. Wait for gateway healthy.
4. Send a follow-up message that references context from step 1.
5. Assert the reply demonstrates context preservation.

If session-resume is NOT working, this is a MED-risk finding (#6 in the risk table) that must be surfaced to the user BEFORE batch 10 cutover.

**Acceptance criteria:**

- [ ] Extensions page renders with two tabs.
- [ ] Pending tab shows mocked pending requests; nav badge count matches.
- [ ] Clicking Approve → daemon `POST /:id/approve` called; toast appears; on SSE `install.applied`, toast updates and the request moves to the Installed tab.
- [ ] Clicking Reject → daemon `POST /:id/reject` called; request disappears from Pending.
- [ ] Installed tab shows installed plugins with audit history.
- [ ] e2e test: full approval pipeline runs end-to-end with a real gateway restart (uses a "no-op test plugin" to install — avoid network dependencies on ClawHub).
- [ ] **Session-resume smoke test passes** — record the result in `docs/OPERATIONS.md` as a verified behavior. If fails, FILE A BLOCKER COMMENT in the PR and surface to user before batch 10 begins.
- [ ] Dashboard build (`npm run build` in dashboard package) succeeds.

**Rollback:** `git revert <commit>`. Dashboard reverts to no-extensions-page state. Daemon routes from 8b and plugin tools from 8c remain functional but orphaned (no UI; operator can still call the API directly via curl in an emergency).

---

## Batch 9 — Cutover preparation: dual-write

**Status:** PENDING
**Depends on:** Batch 8d
**Execution Mode:** serial
**Recommended Executor:** devops-engineer
**Complexity:** simple (1-2h)

**Files affected:**

- **MODIFY:** `docker-compose.yml` — add `DISCORD_TOKEN_ANUBIS`, `DISCORD_TOKEN_HORUS` to `openclaw-gateway` environment; keep `DISCORD_BOT_TOKEN` for now (dual-config compatibility during cutover window).
- **MODIFY:** `entrypoint.sh` (gateway container) — render the new template to `/etc/openclaw/openclaw.json.new` alongside the existing `/etc/openclaw/openclaw.json`. The new file is NOT yet activated.
- **CREATE:** `scripts/cutover-rollback.sh` — operator escape script. Restores `/etc/openclaw/openclaw.json` from a `.bak` snapshot and restarts the gateway. This is the manual recovery the operator runs if batch 10 goes sideways.
- **CREATE:** `docs/CUTOVER_RUNBOOK.md` — step-by-step operator runbook for batch 10. Lists pre-cutover checks, exact commands, smoke-test invocations, rollback steps.

**Notes for executor:**

- This batch ships dual-rendering but **does not activate** the new config. The gateway still reads the OLD `openclaw.json`.
- Backup discipline: before batch 10 runs, `cp /etc/openclaw/openclaw.json /etc/openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)` is the operator's first step (encoded in the runbook).
- Runbook should explicitly note: "operator must have DISCORD_TOKEN_ANUBIS and DISCORD_TOKEN_HORUS valid in `.env` BEFORE running cutover."

**Acceptance criteria:**

- [ ] `docker compose up -d` and `docker exec openclaw-gateway ls /etc/openclaw/` shows BOTH `openclaw.json` AND `openclaw.json.new`.
- [ ] `docker exec openclaw-gateway cat /etc/openclaw/openclaw.json.new | jq .agents.list[0].id` outputs `"anubis"`.
- [ ] Gateway is still running on the OLD config — `docker exec openclaw-gateway curl -s -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" http://127.0.0.1:18789/tools/invoke -d '{"tool":"list_projects"}'` returns 404 "Tool not available" (plugin not loaded yet).
- [ ] `scripts/cutover-rollback.sh` exists, is executable, and a dry-run (`bash -n scripts/cutover-rollback.sh`) parses without errors.
- [ ] `docs/CUTOVER_RUNBOOK.md` reviewed by user (checkpoint moment — surface this for human approval BEFORE batch 10).

**Rollback:** `git revert <commit>`. Drop the dual rendering. Operator can `rm /etc/openclaw/openclaw.json.new`.

---

## Batch 10 — Cutover: openclaw loads the plugin (canary, irreversible-in-the-moment)

**Status:** PENDING
**Depends on:** Batch 9 (dual-write + runbook in place)
**Execution Mode:** serial — **operator-supervised**, do not proceed without user sign-off
**Recommended Executor:** devops-engineer (operator pairs with senior-tester for smoke verification)
**Complexity:** medium (2-4h including verification window)

**Files affected:**

- **MODIFY:** the running container's `/etc/openclaw/openclaw.json` (operator step, not code) — replace with the contents of `openclaw.json.new` produced in batch 9.
- **MODIFY:** `docker-compose.yml` or `entrypoint.sh` — flip the rendering so `openclaw.json` IS the new template; `openclaw.json.new` is no longer needed (but stays for one more batch as belt-and-braces).

**Pre-cutover gate (operator must sign off):**

1. `pre-task-2026-006-cleanup` tag exists in `git tag -l`.
2. Current SQLite DB is backed up (`docker exec openclaw-daemon sqlite3 /data/specs.db ".backup /data/specs.db.bak"`).
3. `/etc/openclaw/openclaw.json.bak.$(date)` snapshot exists in the gateway container.
4. `.env` has valid `DISCORD_TOKEN_ANUBIS` and `DISCORD_TOKEN_HORUS`.
5. Plugin image builds clean (`docker compose build` is green).
6. Bind-mount unit test passes.
7. Operator confirms a low-traffic window (no in-flight Discord conversations).

**Cutover sequence:**

1. **Stop the OLD bot-bridge process.** If host-native (PID 2598), `kill <PID>`; if containerized (no longer present per amendment), `docker compose stop openclaw-bot-bridge` (no such service — skip).
2. Confirm Anubis goes offline on Discord (operator visual check).
3. `cp /etc/openclaw/openclaw.json.new /etc/openclaw/openclaw.json` in the gateway container.
4. `docker exec openclaw-gateway openclaw gateway restart` (or fallback: `docker restart openclaw-gateway`).
5. Wait up to 30s for gateway healthcheck (`curl /health` returns 200).
6. **Smoke tests (per arch §13.1, §13.2):**
   - `curl -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" -X POST http://127.0.0.1:18789/tools/invoke -d '{"tool":"list_projects"}'` returns 200 with `result.content`. (FAIL → roll back.)
   - `curl -H "Authorization: Bearer $OPENCLAW_AUTH_TOKEN" -X POST http://127.0.0.1:18789/tools/invoke -d '{"tool":"list_installed_plugins"}'` returns 200 (tool from batch 8c registered).
   - `docker logs openclaw-gateway 2>&1 | grep -c "registered 12 tools"` returns at least 1 (plugin loaded all tools).
   - Operator DMs `@Anubis ping` on Discord → Anubis replies (not Horus, not silence).
   - Operator DMs `@Horus ping` → Horus replies (not Anubis, not silence).
   - Daemon SSE stream shows `session.created` events with correct `agentId` per bot.
7. If ALL smoke tests pass: declare cutover green. Operator monitors for 24h before batch 11 runs.
8. If ANY smoke test fails: run `scripts/cutover-rollback.sh` (from batch 9), reactivate OLD bot-bridge if applicable, debug, schedule retry.

**Acceptance criteria:**

- [ ] All 7 smoke tests above pass (recorded in `docs/CUTOVER_RUNBOOK.md` post-cutover section).
- [ ] No Discord users report Anubis/Horus offline for >2 minutes during the cutover.
- [ ] Daemon's `/api/health` continues to return `{"ok":true}` throughout the cutover.
- [ ] Schema is still v4→v5 (no inadvertent migration; check `dbVersion` in `/api/health`).
- [ ] Operator signs off in the PR comments: "Cutover complete and stable for [duration]."

**Rollback:** Run `scripts/cutover-rollback.sh` per batch 9. Restore the bot-bridge process (host-side restart). Revert the `docker-compose.yml` change. The OLD chat tier resumes. **Once smoke tests pass and cutover is declared green, rollback is increasingly expensive** (operator-visible if Discord users were active). The recovery anchor `pre-task-2026-006-cleanup` is the global escape hatch via `git reset --hard`.

---

## Batch 11 — Delete the dead chat-tier code

**Status:** PENDING
**Depends on:** Batch 10 (must be green for a minimum of 24h or operator-declared "stable")
**Execution Mode:** serial
**Recommended Executor:** backend-developer
**Complexity:** medium (2-4h — large deletion + docs)

**Files affected:**

- **DELETE:** `openclaw-control/bot-bridge/` (entire directory) — index.ts, chat.ts, llm.ts, commandRouter.ts, agentRegistry.ts, harnessAuthor.ts, daemonClient.ts (already MOVED to plugin), config.ts (MOVED), harness/types.ts, tools/, mcp/ (already DELETED in batch 8), subagents/, skills/, test/, package.json, etc.
- **MODIFY:** `docker-compose.yml` — remove `DISCORD_BOT_TOKEN` from environment (replaced by `DISCORD_TOKEN_ANUBIS` and `DISCORD_TOKEN_HORUS`). Remove any leftover bot-bridge service references.
- **MODIFY:** `.env.example` — drop `DISCORD_BOT_TOKEN`; keep the new tokens documented.
- **MODIFY:** `Dockerfile` — drop any remaining bot-bridge stage if not already done in batch 7.
- **MODIFY:** `CLAUDE.md` — rewrite the "Two tiers, one container" section to reflect the openclaw-plugin model. Update the persona-privacy invariant description (layers 5-6 now in openclaw config + plugin handlers, per arch §7.1). Update the operational doc cross-references.
- **MODIFY:** `docs/OPENCLAW_CONTROL.md` — replace bot-bridge references with plugin references.
- **MODIFY:** `docs/ARCHITECTURE.md` — update the multi-tier diagram.
- **MODIFY:** `docs/CONFIGURATION.md` — drop bot-bridge env-var references; keep daemon and plugin env vars.

**Notes for executor:**

- This is a LARGE deletion. Use `git rm -r openclaw-control/bot-bridge/` in one commit, then the docs/config tweaks in follow-up commits in the same PR.
- Before deleting, run `grep -r "bot-bridge" --include="*.{ts,js,json,yml,md,sh}"` to find any remaining references; fix or document each.
- The two stash entries from the cleanup commits (`refs/stash@{0}`) reference bot-bridge files — they remain in the stash. They are NOT to be popped post-deletion. Document this in the rollback notes.
- The Phase 2 dormant code (`daemon/src/{continuation,dispatch,invoker}.ts` and `db/dispatches.ts`) STAYS — per arch §6.5. Do not delete in this batch.

**Acceptance criteria:**

- [ ] `ls openclaw-control/bot-bridge` returns "No such file or directory."
- [ ] `grep -r "bot-bridge" --include="*.{ts,js}" openclaw-control/ scripts/ config/` returns no results (only docs may still reference it historically — those are explicitly preserved as migration log entries).
- [ ] `docker compose build` succeeds.
- [ ] `docker compose up -d` brings up gateway + daemon + redis, all healthy.
- [ ] `curl /tools/invoke list_projects` round-trip still works (plugin still loaded).
- [ ] CLAUDE.md no longer references "bot-bridge" as a current component; it appears only in the migration-history note.
- [ ] `docs/ARCHITECTURE.md` updated.
- [ ] Phase 2 dormant code (`continuation.ts`, `dispatch.ts`, `invoker.ts`, `db/dispatches.ts`) still on disk — verify with `ls openclaw-control/daemon/src/{continuation,dispatch,invoker}.ts`.

**Rollback:** `git revert <commit>` — restores the bot-bridge directory and docs. Note: docker-compose still references the new config; if the operator needs the OLD bot-bridge process to run, they must also revert `docker-compose.yml` env-var changes from this batch. The recovery anchor `pre-task-2026-006-cleanup` is the cleanest path.

---

## Batch 13 — Documentation and follow-up

**Status:** PENDING
**Depends on:** Batch 11
**Execution Mode:** serial
**Recommended Executor:** backend-developer (or technical-content-writer if available)
**Complexity:** simple (1-2h)

**Files affected:**

- **MODIFY:** `README.md` — top-level project description updated to reflect the new architecture.
- **MODIFY:** `docs/SETUP.md` — new onboarding flow for two-persona deployment; document the two compose services.
- **MODIFY:** `docs/SECURITY.md` — update persona-privacy invariant section (layers 1-4 unchanged; layers 5-6 moved per arch §7.1).
- **MODIFY:** `docs/TROUBLESHOOTING.md` — add new diagnostic entries for plugin-not-loaded (404 "Tool not available"), MCP server failed to start, install request stuck in pending.
- **CREATE:** `docs/PLUGIN_DEVELOPMENT.md` (optional) — how to add a new tool to `openclaw-control/plugin/`.
- **CREATE or APPEND:** migration log entry in `.ptah/specs/TASK_2026_006/` — summary of what shipped, known-unknowns, Phase 2 follow-up backlog.
- **CLOSE:** TASK_2026_006 status → DONE.

**Phase 2/3 follow-up backlog (record, do NOT implement here):**

- Delete dormant continuation/dispatch/invoker code and `dispatches` table (schema v6).
- Drop `harness.yaml.chatTier.mcpServers` field if unused for 60 days.
- Per-persona MCP gating via `tools.deny` glob if operator demand surfaces.
- Cross-machine auto-notify for handoffs (per arch §8.4).
- Plugin/skill auto-update via dashboard.

**Notes for executor:**

- The amendment §10 batches "5b/8b/8c/8d" should be reflected in any final architecture doc retrospective.
- The "TASK_2026_006 complete" tag (`task-2026-006-complete`) should be created on the merge commit to main (if/when the user merges; currently we stay on `ak/fix-internal-calls`).

**Acceptance criteria:**

- [ ] All docs referenced above are updated; `grep -r "bot-bridge"` in `docs/` shows only historical references.
- [ ] CLAUDE.md's "Two tiers, one container" section accurately reflects the new architecture (verified by spot-reading).
- [ ] TASK_2026_006 status marked DONE.
- [ ] Migration log entry summarizes ship state + Phase 2 backlog.

**Rollback:** `git revert <commit>` — purely documentation, fully reversible.

---

## Excluded from this migration (Phase 2/3 follow-up)

These are intentionally NOT in any of the 16 batches:

- **Continuation/dispatch/invoker deletion** — per arch §6.5, stays dormant in tree. Phase 2 task.
- **`dispatches` table drop** — schema migration deferred to Phase 2.
- **`harness.yaml.chatTier.mcpServers` field removal** — informational-only in v1, Phase 3 removal candidate.
- **Per-persona MCP gating via `tools.deny`** — operator-config, no code change needed.
- **Plugin uninstall as agent tool** — explicit out-of-scope per amendment §16.8.
- **Cross-machine auto-notify for handoffs** — operator-initiated re-engagement is the v1 design per arch §8.4.
- **Auto-update of installed plugins/skills** — explicit out-of-scope per amendment §16.9.

---

## Status icons reference

| Status | Meaning | Who sets |
|---|---|---|
| ⏸️ PENDING | Not started | team-leader (initial) |
| 🔄 IN PROGRESS | Assigned to executor | team-leader |
| 🔄 IMPLEMENTED | Executor done, awaiting verify | executor |
| ✅ COMPLETE | Verified and committed | team-leader |
| ❌ FAILED | Verification failed | team-leader |

All batches above are currently PENDING (text status; team-leader updates to icon form on assignment).

---

**End of tasks.md.**
