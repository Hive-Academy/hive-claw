# Security

Honest assessment of the current security posture, what's deliberately not hardened, and what to do if you want stronger isolation.

---

## What this stack assumes about your threat model

The default configuration assumes:

- **Single-user host** — you're the only person on this machine, or all users are trusted.
- **Trusted local network** — the dashboard is loopback-only, but if you expose it to LAN, anyone on your network can reach it.
- **Trusted bot operator** — whoever holds the Discord bot token can control the bot.
- **Trusted skills/configs** — anything in `skills/` or `~/projects/<x>/.openclaw/` runs with the agent's privileges.
- **Personal-scale use** — not a production multi-tenant deployment.

If your threat model is different (shared host, public exposure, untrusted code in skills), see the hardening section below.

---

## What's protected by default

### Container isolation

- Runs as **non-root** (`agent` user, uid 1000).
- Default Docker namespace isolation (PID, network, mount, IPC, UTS, user namespaces depending on engine).
- Filesystem access limited to the container's own image layer + the bind mounts you explicitly grant (`~/projects`, `./skills`).
- Host kernel + processes invisible to the container.

### Secret handling

- `DISCORD_BOT_TOKEN` and `OPENCLAW_AUTH_TOKEN` live in `.env`, which is:
  - **Gitignored** — won't accidentally commit
  - **`chmod 600`** by default — only your user can read it
  - Mounted as Docker env vars (visible to the container's main process via `process.env`)

- The Discord token is also written into `~/.openclaw/openclaw.json` inside the container's named volume. The volume's filesystem is not directly accessible to the host (only via `docker exec` or volume mount).

### Network exposure

- Dashboard port `18789` is **bound to `127.0.0.1` only** — not reachable from your LAN.
- All inbound Discord traffic comes through the bot's outbound WebSocket — no inbound port required.
- No SSH, no VNC, no remote-access protocols inside the container.

### Auth

- Dashboard requires a Bearer token (the `OPENCLAW_AUTH_TOKEN`).
- 32-byte random hex by default — sufficient entropy that brute-force isn't realistic.
- WebSocket connections require the same token.

### Image provenance

- Base: `debian:trixie-slim` (Debian's official image).
- Node 22 from NodeSource's signed APT repo.
- `openclaw` from npm at a pinned version (`openclaw@2026.4.24`).
- All other deps installed by openclaw's bundled plugin loader on first run, into `~/.openclaw/plugin-runtime-deps/` inside the container — these are npm packages from `registry.npmjs.org`.

---

## Control-plane additions

The control plane introduces three new exposure surfaces beyond what the gateway has. Each has its own threat model.

### The leader's spec database

The single SQLite file at `OPENCLAW_SPECS_DB_PATH` (default `/data/specs.db`, persisted via the named docker volume `specs-db`) holds:

- The full task tree (`projects`, `tasks`, `task_files`) — descriptions, plans, code excerpts, sometimes paths to local files. Whatever your agents discuss while orchestrating, ends up here.
- Shared memory (`memory_files` rows for `scope IN ('users','threads','projects')` plus `agents/<id>/identity.md`) — Discord user profiles, channel context summaries, project notes, public agent bios.
- The dispatch queue (`dispatches`) and its audit trail (`dispatch_log`).

What is **not** in the DB:

- Agent personas, secrets — those live in `~/.claude/local-memory/`, never synced and never over HTTP. See "Persona privacy invariant" below.
- Raw operator secrets — but be aware that what an agent *says* during a session lands in the task-file rows. If a user pastes a token into a Discord message, the bot's reply context could surface it. Treat the DB the way you'd treat a sensitive private codebase.

Followers do **not** have a copy of this DB. They are HTTP-only clients of the leader.

### The dashboard (`:7878`)

Three credentials guard it:

- **JWT cookie** (`OPENCLAW_JWT_SECRET` signs it) — issued after Discord OAuth callback. 14-day expiry. Rotate the secret to invalidate every existing session.
- **Internal service token** (`OPENCLAW_INTERNAL_TOKEN`) — used by the bot-bridge and dispatched agents from inside the same container. Constant-time comparison. Rotate by generating a new value, updating `.env`, restarting.
- **Discord OAuth allowlist** — `DISCORD_ALLOWED_USER_IDS` first, `DISCORD_ALLOWED_GUILD_ID` if the first is empty, deny if both are empty.

If you expose the dashboard publicly (Tailscale Funnel, Caddy, Cloudflare Tunnel) **and** leave `DISCORD_ALLOWED_USER_IDS` empty **and** leave `DISCORD_ALLOWED_GUILD_ID` empty, the daemon refuses remote logins entirely (only the localhost `local-dev` fallback works, which isn't reachable through the tunnel). This is a deliberate fail-closed default — don't try to "fix" it by removing the check.

### Tailscale Funnel exposure

Funnel publishes whatever's on `localhost:7878` to the public internet. Auth lives entirely in the daemon. Things that can go wrong:

- Allowlist mis-set → anyone with a Discord account hits your dashboard.
- OAuth redirect URI mismatch → users can't log in (this is the safe failure mode; the dangerous one is the previous bullet).
- The Discord OAuth app's "Client Secret" leaks → an attacker can mint OAuth flows that look like yours, but they still need a user ID in your allowlist to actually pass `isAuthorized()`. Defense in depth: rotate the client secret quarterly.

When you stop using Funnel: `tailscale funnel reset` AND set `OPENCLAW_CONTROL_BIND=127.0.0.1` AND remove the public URL from the OAuth Redirects list.

### Persona privacy invariant

The `local-memory/agents/<id>/persona.md` file is the agent's voice. The implementation-plan §8 specifies a three-layer defense for the read/write path; TASK_2026_002 adds a **fourth layer** to cover the new harness-materialization writer. Each layer would, by itself, prevent a leak. We run all four because programming errors happen and the cost of a leak is high. **The privacy invariant itself is unchanged** — what TASK_2026_002 adds is a new writer (`harness/materialize.ts`) operating on a different tree (the materialized ptah config), and a fourth layer that hard-asserts the new writer cannot reach the private tree.

**Layer 1 — FS chokepoint** (`daemon/src/memory.ts`):
`resolveBackend(scope, id, filename)` is the single function every read/write/delete passes through. When `scope === 'agents' && PRIVATE_AGENT_FILES.has(filename)`, it returns `{kind: 'local', dir: localAgentDir(id), filename}` and the caller writes to `~/.claude/local-memory/agents/<id>/<filename>`. The "shared" branch — `MemoryRepo.read/write/delete` against the SQLite `memory_files` table — is never reached for these names. `PRIVATE_AGENT_FILES = {persona.md, secrets.md, persona.json, secrets.json}` is the canonical allowlist, declared once in `daemon/src/db/memory.ts` and re-exported through the barrel. The DB literally never sees a row with one of these filenames in scope=agents.

**Layer 2 — HTTP gate** (`daemon/src/api.ts`):
The memory routes check the same allowlist *before* any DB query.
- `PUT /api/memories/agents/:id/<private-file>` returns **403** with `{error: 'private agent files cannot be sent over the network'}`.
- `DELETE /api/memories/agents/:id/<private-file>` — same 403.
- `GET /api/memories/agents/:id/<private-file>` returns **404** with `{error: 'not found'}`.

The 404 on GET is deliberate, not 403. A 403 would leak the existence of a persona ("there's a persona behind this URL but you can't have it"); a 404 is indistinguishable from "no such file". This is per implementation-plan.md §8 lines 805-811.

**Layer 3 — defense-in-depth allowlist** (`daemon/src/db/memory.ts`):
`MemoryRepo.write` and `MemoryRepo.delete` call `assertNotPrivate(scope, filename)` synchronously, which `throw`s if a private filename ever reaches the repo. `MemoryRepo.read` returns `null` rather than reading the DB. This is the belt-and-braces guard: if a future contributor refactors the chokepoint or adds a code path that bypasses `resolveBackend`, the repo refuses anyway. A bug becomes a hard crash, not a silent leak.

**Layer 4 — materialization output guard** (`daemon/src/harness/materialize.ts`):
The harness materializer writes a per-agent ptah config tree (`~/.ptah/agents/<id>/settings.json`, `~/.ptah/plugins/openclaw-<id>-harness/.claude-plugin/plugin.json`, `~/.ptah/plugins/openclaw-<id>-harness/agents/<n>.md`). These outputs are **config, not memory** — they hold skill names, MCP server specs, subagent system prompts, all of which are public by construction (sourced from the public `harness.yaml`). The persona-privacy invariant does not apply to them.

What this layer does is hard-assert the new writer cannot accidentally reach the private tree. `assertMaterializedPathSafety(resolved)` runs before every write and throws if the resolved absolute path lives under `config.localMemoryRoot` (default `~/.claude/local-memory/`). A misconfigured `OPENCLAW_HOST_HOME`, a path-traversal in an agent id, or a future contributor adding a new write target inside `materialize.ts` all hit this guard rather than silently writing into local-memory. The crash is the contract.

All four invariants — DB never holds a private row, HTTP API responds 403 (write) and 404 (read) on a private filename, and the materializer refuses any path under local-memory — are continuously verified by `openclaw-control/daemon/test/persona-privacy.test.ts` and (for layer 4) by the materialize unit tests.

Audit note (TASK_2026_002 forward-looking, not a fix for a known vulnerability): `safeFile`'s `.yaml` extension allowance in `daemon/src/memory.ts` was added in B3 to enable `harness.yaml` shared-memory storage. The privacy invariant is currently intact because `PRIVATE_AGENT_FILES` is a literal-set match — `persona.yaml` is NOT a member and would route to shared, which is documented behavior, not a leak. A future surface-area minimization would scope-narrow the regex to `harness.yaml` only, or extension-gate by scope. Tracked as a backlog audit item.

Things the system does **not** guarantee:

- That the operator hasn't intentionally pasted persona content into a Discord reply, a task description, or a `memory_files` row for `users/`. The privacy is structural, not semantic.
- That a malicious skill running inside the container can't `cat` the file. Container = same trust as the host shell. If you don't trust a skill, don't install it.

### DB at rest

The SQLite file lives at `OPENCLAW_SPECS_DB_PATH` (default `/data/specs.db`) inside the leader's container. It is owned by uid 1000 (the `agent` user) with file mode `0600`. The named docker volume `specs-db` is the persistent backing store on the host.

**There is NO encryption at rest.** Any operator with read access to the leader host's docker volume directory can read every `memory_files` row, every dispatch prompt, and every `dispatch_log` line. This is a known accepted risk per implementation-plan.md §15 line 1270.

Mitigation today:

- Keep the host directory `chmod 0700` and limit shell access on the leader host. (`docker volume inspect openclaw_specs-db` will show you the mountpoint on the host.)
- Treat the leader host the way you'd treat any single-tenant database server: only the operator should be able to log in.
- Rotate `OPENCLAW_INTERNAL_TOKEN` if you suspect a follower or bot-bridge token leak (every authenticated reader of the API would have to be re-credentialled anyway).
- Take a `.backup` snapshot before doing anything risky to the DB. See `docs/OPERATIONS.md`.

If you need at-rest encryption: layer the host filesystem with LUKS or use a docker volume driver that does block-level encryption. The daemon does not implement application-level encryption and there are no plans to add it.

### Migration / decommission

When retiring a machine:

1. `docker compose down` on it.
2. Copy `~/.claude/local-memory/agents/<id>/persona.md` to wherever the agent is moving (encrypted channel — scp, password manager, signed envelope).
3. Wipe `~/.claude/local-memory/` on the old host (`shred -u ...` if the file was sensitive).
4. Rotate `DISCORD_TOKEN_<id>` if you suspect the old machine could still be online.
5. Remove `<id>` from the *new* machine's `OPENCLAW_LOCAL_AGENT_IDS` only after you're sure the persona file is in place.

The leader's DB doesn't need any cleanup — the agent's `identity.md` (public bio) stays in `memory_files`. If you want to wipe the public bio too, run `DELETE FROM memory_files WHERE scope='agents' AND owner_id='<id>'` on the leader.

---

## What's NOT hardened (and why)

These are deliberate omissions for a personal-use stack. If you need them, see the next section.

| Not done | Why it's fine for personal use | When to reconsider |
|---|---|---|
| `read_only: true` filesystem | OpenClaw needs to write to `~/.openclaw/` (sessions, plugin deps, memory). Solvable with tmpfs but adds complexity. | Multi-tenant or public deployment |
| `cap_drop: [ALL]` | OpenClaw plugins use various caps (browser plugin needs network, etc.) — would need careful audit. | Untrusted skills or public exposure |
| `no-new-privileges: true` | Agent isn't expected to escalate, but no specific reason to allow it either. Easy win. | Always — see below |
| `mem_limit`, `cpus`, `pids_limit` | Single-user host — runaway agent affects only the user, not other tenants. | Shared host |
| Egress allowlist (firewall outbound) | Container has unrestricted outbound, including npm-registry, ollama-cloud, discord, anywhere skills want. | Sensitive environments where data exfiltration is a concern |
| Docker secrets (`/run/secrets/`) instead of env vars | Env vars are visible inside the container via `env` command. Skills/agents you trust can read them. | Untrusted skills/agents |
| Image scanning | Once on first build it's worth running, but not automated here. | Production |
| Network policy (which hosts the container can call) | None — the agent can call any HTTPS endpoint. Useful: the agent can fetch docs, install dev deps. Risky: skills could exfiltrate data. | Sensitive data in workspace |

---

## Easy hardening wins

These add real protection without breaking functionality. Apply them all if your machine has anything sensitive.

### 1. `no-new-privileges` and dropped caps

Edit `docker-compose.yml`, add to the `openclaw` service:

```yaml
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE   # only if openclaw needs to bind low ports — it doesn't, so leave this off
```

Restart:

```bash
docker compose up -d --force-recreate
```

If the gateway fails to start with caps dropped, add them back one at a time until it works, and document which one was needed.

### 2. Resource limits

```yaml
    mem_limit: 2g
    cpus: 2.0
    pids_limit: 512
```

Prevents a runaway plugin (browser/Playwright is the usual suspect) from eating the whole machine.

### 3. Read-only root with selective writable paths

```yaml
    read_only: true
    tmpfs:
      - /tmp:rw,size=128m,mode=1777
      - /home/agent/.npm:rw,size=64m
```

Note: `/home/agent/.openclaw/` is already a writable named volume, so the read-only root doesn't break openclaw's state writes — only the rest of the container becomes read-only.

You may need to add other tmpfs paths if openclaw plugins write elsewhere. Test by running and checking for `EROFS` errors.

### 4. Use Docker secrets for tokens

Instead of `.env` env vars, mount tokens at `/run/secrets/`:

```yaml
services:
  openclaw:
    secrets:
      - discord_bot_token
      - openclaw_auth_token

secrets:
  discord_bot_token:
    file: ./secrets/discord_bot_token
  openclaw_auth_token:
    file: ./secrets/openclaw_auth_token
```

Then update `entrypoint.sh` to read from `/run/secrets/<name>` instead of `$DISCORD_BOT_TOKEN`. The token files are mounted with `tmpfs` permissions and not visible via `env`.

### 5. Restrict the bot's Discord scope

In Discord Developer Portal:

- **Public Bot: OFF** (only you can invite it)
- **OAuth2 URL Generator** with minimum permissions: `View Channels`, `Send Messages`, `Read Message History` only — drop everything else.
- One bot per machine, not one bot shared. Easier to revoke a specific token if compromised.

### 6. Per-channel permission lockdown

Even if the bot is in your guild, you can restrict it to specific channels. In Discord:

1. Right-click each channel where you want the bot → Edit Channel → Permissions.
2. Add `@your-bot` role with View/Send/Read explicitly.
3. In all other channels, the bot inherits @everyone perms — if @everyone can't see the channel, neither can the bot.

This way the bot only sees and replies in channels you explicitly allow.

---

## Heavier hardening (if you really want it)

### Egress allowlist

Restrict the container's outbound network to specific hosts. Two approaches:

**(a) Sidecar HTTP proxy** — run a Squid or tinyproxy container that allows only specific destinations, route the openclaw container's egress through it via `HTTP_PROXY` env var.

**(b) iptables on the host** — write rules that reject outbound from the container's docker network except to specific IPs/ports. Survives container recreates but breaks on Docker network restart (different bridge IP).

Both are nontrivial. Start with what you actually need to allow:

- `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com` (Discord)
- `host.docker.internal:11434` (Ollama)
- `registry.npmjs.org` (plugin installs — only on first start)
- `ollama.com` (cloud-routed models)
- Whatever URLs skills need (docs sites, search engines)

### Rootless Docker

Run Docker in rootless mode so even container escape doesn't get root on the host. Adds friction for `bin/openclaw-init-project.sh` (uid mismatches) — solvable but not seamless.

### gVisor or Kata Containers runtime

Replace Docker's default `runc` with `runsc` (gVisor — userspace kernel) or `kata-runtime` (lightweight VM per container). Strong isolation, some compatibility loss with certain syscalls, performance overhead.

### Stop using `*:cloud` models

Ollama Cloud sends prompts and conversation history to ollama.com. If your conversations contain anything sensitive, switch to local-only models (requires GPU). The audit trail is then entirely on your machine.

---

## Things to avoid

These have shown up during setup as anti-patterns:

- **Don't paste tokens into chat windows or screenshots.** They get OCR'd and indexed by surprise things.
- **Don't put `.env` in any git remote.** Even private repos can be cloned by collaborators or leaked via misconfigured CI.
- **Don't bind the dashboard to `0.0.0.0` without strong auth.** The default `127.0.0.1` is intentional — anyone on your LAN reaching `<your-ip>:18789` could otherwise just need the token (or brute-force it if it's weak).
- **Don't run `docker compose down -v` casually.** It deletes the named volume — bot memory and session history go with it.
- **Don't blindly accept skills from untrusted sources.** A skill is just markdown, but it can instruct the agent to do things — read sensitive files, exfiltrate to a webhook, run commands. Treat skills like you'd treat a script you're about to run as your own user.
- **Don't store your only copy of identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`) inside the named volume.** They're now in `~/projects/` (host-side), but old setups had them inside `~/.openclaw/workspace/` which gets wiped on `down -v`.

---

## Reporting issues

If you find a security issue with this stack:

- **OpenClaw upstream**: https://github.com/openclaw/openclaw/issues
- **This setup specifically**: open an issue or PR on the repo you cloned this from.

Don't post tokens, secrets, or full conversation history in public bug reports — sanitize first.
