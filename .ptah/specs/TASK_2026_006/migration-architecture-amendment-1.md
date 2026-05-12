# TASK_2026_006 — Migration Architecture Amendment 1

**Status:** DRAFT — pending user approval before team-leader decomposition
**Date:** 2026-05-12
**Supersedes:** sections §3.10 (`start_harness_setup`), §9 (deployment) of `migration-architecture.md`
**Adds:** §16 (plugin/MCP self-extension feature)
**Inputs:** the user's checkpoint responses captured in this round

This amendment is read AFTER `migration-architecture.md`. The body of that doc is unchanged for everything not explicitly superseded here.

---

## Decisions captured this round

| # | Decision | Disposition |
|---|---|---|
| 1 | **Container-native deployment.** openclaw + daemon + dashboard run via `docker compose`. Ptah-bridge stays on host as a shell-executable wrapper around the `ptah-cli` binary. | Replaces §9 |
| 2 | **Plugin/MCP install:** approval-mode (β). Agents file requests; operators approve on dashboard; install + gateway-restart happens after approval. | New feature, see §16 |
| 3 | **MCP scope:** config-wide. All approved MCP servers are available to all agents. Per-agent narrowing via `tools.deny` is optional (operator's discretion), not v1 default. | §16, §4 (config template) |
| 4 | **Skills scope:** config-wide. Same as MCP — all approved skills are available to all agents. | §16 |
| 5 | **`start_harness_setup`:** removed entirely from the plugin's registered tool set (was "stub" in architect's default, now "delete"). | §3.10 supersedes |
| 6 | **Container split:** two compose services — `openclaw-gateway` (openclaw + plugin) and `openclaw-daemon` (daemon + dashboard). Required to restart the gateway after plugin install without taking down the daemon. | §9 (new) |

§9.3 "deployment clarifications needed" from the original doc is now resolved by decision #1 — docker compose IS the deployment.

---

## §9 (new) — Containerized deployment

### 9.1 Service topology

```yaml
services:
  openclaw-gateway:
    image: openclaw-local:latest
    container_name: openclaw-gateway
    restart: unless-stopped
    command: ["openclaw", "gateway", "--port", "18789", "--bind", "lan"]
    ports:
      - "127.0.0.1:18789:18789"
    env_file: .env
    volumes:
      - openclaw-state:/home/agent/.openclaw
      - openclaw-extensions:/home/agent/.openclaw/extensions
      - openclaw-skills:/home/agent/.openclaw/skills
      - ~/.config/gh:/home/agent/.config/gh:ro       # gh CLI auth from host
      - ~/.ptah:/home/agent/.ptah                     # ptah config (read by plugin)
    depends_on:
      openclaw-redis:
        condition: service_healthy

  openclaw-daemon:
    image: openclaw-local:latest                      # SAME image, different command
    container_name: openclaw-daemon
    restart: unless-stopped
    command: ["node", "/opt/openclaw-control/daemon/dist/index.js"]
    ports:
      - "127.0.0.1:7878:7878"
    env_file: .env
    volumes:
      - openclaw-data:/data                           # SQLite specs.db
      - openclaw-state:/home/agent/.openclaw:ro       # daemon READS openclaw config
      - /var/run/docker.sock:/var/run/docker.sock     # for gateway restart cap
    depends_on:
      - openclaw-gateway
      - openclaw-redis

  openclaw-redis:
    image: redis:7-alpine
    container_name: openclaw-redis
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3

volumes:
  openclaw-state:        # ~/.openclaw/ — config, sessions, runtime state
  openclaw-extensions:   # ~/.openclaw/extensions/ — user-installed plugins
  openclaw-skills:       # ~/.openclaw/skills/ — user-installed skills (incl. MCP-skill bundles)
  openclaw-data:         # /data/specs.db — daemon's SQLite
```

### 9.2 Rationale for the container split

The original arch doc described one container. Splitting into two compose services is forced by the plugin-install flow: when the operator approves a plugin install, we need to restart **openclaw without restarting the daemon** (otherwise the dashboard's approval UI itself goes down mid-action, and the operator's session breaks). Two containers gives us independent lifecycles.

The image is the SAME (`openclaw-local:latest`) — the only difference between services is the `command:` line. So this is a deployment-layout change, not a build-system change.

### 9.3 Restart mechanism

When the operator approves a plugin install, the daemon executes the install + restart:

```
1. Daemon runs:  docker exec openclaw-gateway openclaw plugins install <slug>
                 (or: openclaw skills install <slug> for MCP-skill installs)
2. Daemon runs:  docker restart openclaw-gateway
   (uses the bind-mounted /var/run/docker.sock + dockerode npm client)
3. Daemon updates extension_install_requests row to status='applied'
4. Daemon emits SSE event: install.applied
5. Dashboard shows "applied" toast; Discord reconnects within ~5-15s
```

**Why docker.sock instead of `openclaw gateway restart`?** Per the docs, `openclaw gateway restart` exists as a CLI command. We could use that — it'd be `docker exec openclaw-gateway openclaw gateway restart`. **The CLI restart is safer** (lets openclaw gracefully drain in-flight tool calls); the docker restart is harder (SIGKILL on slow shutdown). **Default: use `openclaw gateway restart`; fall back to `docker restart` if the CLI command returns nonzero or hangs >30s.**

Either way the daemon needs to be able to exec into the gateway container — that's what the docker socket bind is for. Alternative without socket access: an HTTP endpoint inside openclaw (`POST /__openclaw__/restart` with admin auth) — needs verification that openclaw exposes one. Worth the team-leader checking during batch 5b implementation.

### 9.4 Ptah-bridge — host-side shell wrapper

Ptah-bridge stays out of the container by design. The user's `~/.claude/` credentials are the source of truth for claude-cli auth; bind-mounting them into a container widens the attack surface unnecessarily.

**Host setup (one-time, encoded in `setup.sh` post-amendment):**

```bash
# ~/.local/bin/ptah-bridge (or wherever the user prefers)
#!/usr/bin/env bash
exec node /path/to/openclaw-control/scripts/ptah-bridge.mjs "$@"

# systemd user unit (optional, recommended):
# ~/.config/systemd/user/ptah-bridge.service
[Unit]
Description=Openclaw ptah-bridge (host-side)
After=network.target

[Service]
Type=simple
ExecStart=/home/%u/.local/bin/ptah-bridge
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The plugin's `invoke_ptah` tool reaches ptah-bridge via `host.docker.internal:8744` (already configured in `docker-compose.yml` via `extra_hosts: ["host.docker.internal:host-gateway"]`).

### 9.5 Volume map summary

| Volume | Mounted at | Contains | Backup priority |
|---|---|---|---|
| `openclaw-state` | `/home/agent/.openclaw/` | openclaw.json, session store, runtime state | HIGH |
| `openclaw-extensions` | `/home/agent/.openclaw/extensions/` | User-installed plugins from ClawHub/npm | HIGH |
| `openclaw-skills` | `/home/agent/.openclaw/skills/` | User-installed skills (incl. MCP-skill bundles) | HIGH |
| `openclaw-data` | `/data/` | Daemon's SQLite (`specs.db`) — includes `extension_install_requests` table | CRITICAL |

`openclaw-state` covers `extensions/` and `skills/` as subdirectories already. The explicit nested volumes are belt-and-braces — they ensure a future change to `openclaw-state`'s mount doesn't accidentally make installed plugins/skills ephemeral.

**Verification step for team-leader (batch 6):** run `openclaw plugins install npm:@openclaw/web-search` in a probe container, then `find /home/agent/.openclaw -newer /tmp/probe-start` to confirm the actual install paths match the volume layout. If openclaw writes elsewhere (e.g., `/var/lib/openclaw/...`), adjust the volumes before locking the compose file.

---

## §3.10 (replaces original) — `start_harness_setup` REMOVED

The original architecture proposed stubbing this tool with a "rebuild pending" return value. Per user decision in this round: **the tool is removed entirely from the registered tool set.**

Practical effect:
- The plugin's `src/tools/index.ts` registers 6 daemon-CRUD tools, not 7. (`list_projects`, `list_tasks`, `get_task`, `create_task`, `approve_task`, `handoff_task`.)
- The `start_harness_setup` tool name does NOT appear in any `tools.allow` block in `openclaw.json.tmpl`.
- Any reference to `start_harness_setup` in code paths is dead (already stashed for chat.ts via the cleanup, daemon-side never had a route to call it directly).
- The harness-author **flow** itself isn't dead — it can be re-introduced in Phase 2 as a dashboard-driven flow (not a chat tool) when there's a clear need.

The "9 tools" → "7 tools" doc-rot fix at `daemonTools.ts:99` was already planned in batch 1 of the migration sequence; that count now becomes **"6 tools"** in the comment for the new plugin.

---

## §16 (new) — Plugin/MCP self-extension feature

### 16.1 Feature summary

Agents can request the installation of openclaw plugins (`clawhub:<slug>` or `npm:<pkg>`) and openclaw skills (which bundle MCP servers). Installs do not happen until an operator approves on the dashboard. After approval, the daemon executes the install command, restarts the gateway, and the new capability is available to ALL agents (config-wide scope per decision #3/#4).

### 16.2 Schema additions — `extension_install_requests` table

```sql
CREATE TABLE extension_install_requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                TEXT NOT NULL CHECK (kind IN ('plugin', 'mcp_skill')),
    slug                TEXT NOT NULL,                       -- e.g. 'clawhub:dbalve/fast-io' or 'npm:@openclaw/web-search'
    requesting_agent_id TEXT NOT NULL,                       -- which agent asked
    reason              TEXT,                                -- the agent's stated reason
    status              TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','applied','failed')),
    operator_note       TEXT,                                -- operator's approval/rejection comment
    install_output      TEXT,                                -- captured stdout+stderr from openclaw install command
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at          TEXT,                                -- when operator approved/rejected
    applied_at          TEXT                                 -- when install completed (status=applied) or failed
);

CREATE INDEX idx_install_requests_pending ON extension_install_requests(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_install_requests_agent ON extension_install_requests(requesting_agent_id, created_at DESC);
```

Schema migration v5 (current is v4 per research-findings §B4-addendum finding #4). Migration is additive only — no destructive changes to existing tables.

### 16.3 New daemon routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/extensions/install-requests` | Bearer (internal) | Plugin tool files a request. Body: `{kind, slug, requestingAgentId, reason?}`. Returns: `{requestId, status:'pending'}`. |
| `GET` | `/api/extensions/install-requests/pending` | Cookie (operator) | Dashboard lists pending requests for the approval queue. |
| `GET` | `/api/extensions/install-requests/:id` | Cookie or Bearer | Get a single request (status polling, audit). |
| `POST` | `/api/extensions/install-requests/:id/approve` | Cookie (operator) | Trigger the install + restart pipeline. Body: `{note?}`. Returns `{status:'approved', estimatedRestartSeconds:10}`. |
| `POST` | `/api/extensions/install-requests/:id/reject` | Cookie (operator) | Mark rejected. Body: `{note?}`. Returns `{status:'rejected'}`. |
| `GET` | `/api/extensions/installed` | Bearer or cookie | List currently-installed plugins + skills. Plugin tool uses this for `list_installed_plugins` / `list_installed_mcp_skills`. |

SSE events on `/api/stream?topics=installs`:
- `install.requested` — new pending request created
- `install.approved`, `install.rejected` — operator decision
- `install.applied`, `install.failed` — install pipeline finished

### 16.4 New plugin tools

Five new tools in the plugin, registered alongside the 6 daemon-CRUD tools + `invoke_ptah`:

| Tool | Description | Parameters | Returns |
|---|---|---|---|
| `request_plugin_install` | File an install request for an openclaw plugin. Does NOT install; awaits operator approval. | `slug: string`, `reason?: string` | Markdown summary with `requestId` and pending status |
| `request_mcp_skill_install` | File an install request for a ClawHub skill (typically containing an MCP server). Does NOT install; awaits operator approval. | `slug: string`, `reason?: string` | Same shape |
| `list_installed_plugins` | List currently-installed openclaw plugins available to this agent. | (no params) | Markdown table |
| `list_installed_mcp_skills` | List currently-installed skills (including their bundled MCP tools). | (no params) | Markdown table |
| `search_clawhub` | Search ClawHub for installable plugins/skills matching a query. | `query: string`, `kind?: 'plugin'\|'skill'` | Markdown table of results |

**`search_clawhub` implementation:** wraps `openclaw plugins search <query>` via `docker exec openclaw-gateway`. If openclaw exposes an HTTP endpoint for search at `:18789` (TBD by team-leader during implementation), prefer that — avoids the exec hop.

**Important:** these tools are config-wide-scope. Anubis requesting `clawhub:dbalve/fast-io` results in fast-io being available to Horus too once approved. The `requestingAgentId` is recorded for audit purposes only.

### 16.5 Install pipeline (daemon-side)

When an operator approves a request:

```
POST /api/extensions/install-requests/:id/approve
  ↓
daemon validates the request is pending
daemon UPDATE extension_install_requests SET status='approved', decided_at=now, operator_note=...
daemon emits SSE: install.approved
  ↓
daemon enqueues an install job (in-process worker, no Redis needed for v1)
  ↓
install worker:
  1. Reads request (kind, slug)
  2. Runs: docker exec openclaw-gateway openclaw <plugins|skills> install <slug>
     captures stdout+stderr to install_output column
  3. If exit code 0:
     - Runs: docker exec openclaw-gateway openclaw gateway restart
       (or, on failure, docker restart openclaw-gateway)
     - Waits up to 30s for openclaw-gateway healthcheck (curl /health) to return 200
     - UPDATE status='applied', applied_at=now
     - SSE: install.applied
  4. If exit code != 0:
     - UPDATE status='failed', applied_at=now, install_output=<captured>
     - SSE: install.failed
     - No restart triggered (gateway state preserved)
```

**The install worker is in-process in the daemon, not a separate queue.** Bounded concurrency = 1 (only one install runs at a time globally; subsequent approved requests queue and process serially). Justified because:
- Restart is global — running two installs in parallel doesn't help, the second still has to wait for the first's restart to settle.
- Install/restart cycle is ~15-30s; queuing doesn't materially slow the operator down.
- Simpler code path (no Redis queue, no worker-process supervision).

### 16.6 Approval UX on the dashboard

The dashboard gets a new "Extensions" page with two tabs:

**Tab 1: Pending approvals (with badge count on the nav).**

```
┌─────────────────────────────────────────────────────────────────┐
│ Extensions › Pending approvals                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Anubis wants to install:                                       │
│    📦 clawhub:dbalve/fast-io  (skill, includes MCP)             │
│    Reason: "I need cloud storage tools to handle the upload     │
│             you asked about earlier."                           │
│    Requested: 2 minutes ago                                     │
│                                                                 │
│    Note (optional): [_____________________________________]     │
│                                                                 │
│    [Approve & Apply now]  [Approve, apply on next restart]      │
│    [Reject]                                                     │
│                                                                 │
│  Anubis wants to install:                                       │
│    📦 npm:@playwright/openclaw-plugin  (plugin)                 │
│    Reason: "Browser automation for the user's monitoring task." │
│    Requested: 5 minutes ago                                     │
│                                                                 │
│    [Approve & Apply now]  [Approve, apply on next restart]      │
│    [Reject]                                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Tab 2: Installed inventory + decision history (audit).**

```
Installed plugins:
- @openclaw/web-search (bundled)
- clawhub:dbalve/fast-io (installed by anubis, approved by op 2026-05-12)

Recent decisions:
- 2026-05-12 14:30: Rejected clawhub:foo/bar (operator note: "we don't need that")
- 2026-05-12 12:15: Approved npm:@openclaw/web-search
```

**Apply-now vs apply-on-next-restart:**
- "Apply now" triggers the install pipeline immediately.
- "Apply on next restart" updates `status='approved'` but doesn't trigger the install worker. Next time the operator manually restarts the gateway (or the container hits its `restart: unless-stopped` policy on a crash), the entrypoint runs all approved-but-not-applied installs in order before openclaw starts.

This dual mode lets the operator avoid mid-conversation restarts during busy times.

### 16.7 Restart UX flow

When "Apply now" is clicked:

```
t=0    Operator clicks Approve & Apply now
t=0    Dashboard shows: "Installing... estimated 10-30s downtime."
t=0    Anubis is mid-conversation? Anubis's session is paused (openclaw exits).
       Discord shows Anubis briefly offline (~5-10s).
t=2    docker exec openclaw plugins install completes (success)
t=5    docker exec openclaw gateway restart issued
t=7    openclaw process exits cleanly
t=8    Docker restart policy or compose brings it back up
t=12   openclaw bound on :18789, sessions auto-resume from session store
t=12   Discord reconnects, Anubis appears online
t=12   Operator sends next message: "Did it work?"
       Anubis responds with continued context: "Yes, fast-io is available now.
       Should I upload that file we discussed?"
       (Session resumed from the moment before restart.)
```

**The session-resume guarantee** depends on openclaw's session store persistence. The researcher's B4 probe showed `sessions_list` returns persistent sessions across restarts — this should work, but **team-leader to add a smoke test in batch 8d** that explicitly: starts a session, restarts the gateway, sends a follow-up message, confirms the context is preserved.

### 16.8 Security considerations

- **Approval is mandatory.** No agent can install anything without operator click. Enforced at the daemon route: `POST /api/extensions/install-requests` only creates `status='pending'`; only `POST /:id/approve` triggers the install pipeline; only cookie auth (operator session) can call approve/reject.
- **ClawHub verification:** prefer plugins with the `@openclaw` Verified badge. Dashboard UI shows a "Verified" tag next to verified plugins; operators can filter to verified-only.
- **Audit trail:** every install request has `requesting_agent_id`, decision history, operator note, and captured install output. Full audit log retained in SQL.
- **Persistence:** installed plugins/skills live in `openclaw-extensions` and `openclaw-skills` named volumes. They survive container rebuilds. Operator can `docker volume rm` to wipe and re-approve from scratch.
- **Rollback:** to uninstall, operator runs `docker exec openclaw-gateway openclaw plugins uninstall <slug>` manually. v1 does NOT expose uninstall as an agent tool (intentional — uninstall has cascading effects that should be operator-considered).

### 16.9 What this feature is NOT (out of scope for v1)

- Auto-update of installed plugins/skills (manual `openclaw plugins update <slug>` for now)
- Per-persona MCP scoping (config-wide only; per-persona deny lists are operator-config, not feature-level)
- Plugin sandboxing beyond openclaw's existing per-agent sandbox config (whatever openclaw offers, we inherit)
- Mid-conversation queueing of multiple installs (serial only — operator deals with one at a time)
- Cross-machine install coordination (each machine's openclaw maintains its own installed set; if leader installs X, follower does NOT auto-install X)

The cross-machine point in particular: on a 2-machine setup, the operator will need to approve installs on BOTH machines' dashboards if they want consistent capabilities across personas on different machines. This is the same shape as the existing persona-machine binding — accepted.

---

## §10 (amended) — Migration sequence updates

Three new batches inserted into the original 13-batch sequence:

| New batch # | Title | Depends on | Description |
|---|---|---|---|
| 5b | **Container split + compose rewrite** | 5 | Split current Dockerfile entrypoint into two services (`openclaw-gateway`, `openclaw-daemon`). Update `docker-compose.yml` per §9.1. Verify docker.sock bind works for daemon → gateway exec. |
| 8b | **Extension install request schema + daemon routes** | 8 | Schema migration v5 (add `extension_install_requests` table). Six new daemon routes per §16.3. Install worker (in-process). |
| 8c | **Plugin tools for install requests** | 8b | Five new plugin tools per §16.4. Connect to daemon's new routes via `daemonClient.ts`. |
| 8d | **Dashboard approval UI** | 8b + 8c | Extensions page (pending tab + installed tab). SSE subscriptions for live updates. Restart smoke test. |

Updated final batch count: **16 batches** (was 13).

Batch dependencies updated: original batch 12 (cutover) is now blocked on 8d completing (the install approval UI must work before cutover so the operator can install anything they need for the new agents).

Batch 1 ("doc-rot fix") still independent — can land first as a no-risk warm-up.

---

## §3.10 ⇒ summary of changes from original arch doc

Replace the section's "stub returning 'rebuild pending'" content with: **"The `start_harness_setup` tool is not registered. The harness-author flow is removed from the chat tier entirely. If/when needed in the future, re-introduce as a dashboard-driven flow, not a chat tool."**

---

## Open items not addressed in this amendment

None block doc approval. The following will surface to the team-leader during decomposition:

1. **Exact path verification for `openclaw plugins install` output.** Team-leader runs the probe described in §9.5 during batch 6 to confirm the volume layout.
2. **`openclaw gateway restart` vs `docker restart` mechanism.** Team-leader tests both in batch 5b and picks the safer one for the install pipeline.
3. **Session-resume verification.** Team-leader's batch 8d smoke test explicitly covers the "session survives gateway restart" case.

---

**End of migration-architecture-amendment-1.md**
