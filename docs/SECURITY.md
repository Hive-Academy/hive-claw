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

### The shared specs repo (`OPENCLAW_SPECS_REPO_URL`)

**Must be a private repo.** It holds:

- The full task tree under `specs/<project>/TASK_*` — descriptions, plans, code excerpts, sometimes paths to local files. Whatever your agents discuss while orchestrating, ends up here.
- Shared memory under `memory/{users,threads,projects}/` — Discord user profiles, channel context summaries, project notes.
- The dispatch queue under `specs/<project>/<task>/.dispatch/` — JSON dispatch records, one per inter-machine handoff.

What is **not** in the repo:

- Agent personas (those live in `local-memory/`, never synced).
- Run logs (`.invoker/` is `.gitignore`d).
- Raw secrets — but be aware that what an agent *says* during a session lands in the task artifacts. If a user pastes a token into a Discord message, the bot's reply context could surface it. Treat the repo as you'd treat a sensitive private codebase: limit collaborator access, audit pushes occasionally.

The PAT (`OPENCLAW_GIT_TOKEN`) needs `repo` scope. Use a fine-grained PAT scoped to **only this repo** if your GitHub plan supports it. Rotate by generating a new PAT, updating `.env` on every machine, and `./scripts/dc.sh compose up -d` on each.

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

The `local-memory/agents/<id>/persona.md` file is the agent's voice. Things the system guarantees about it:

- **Never written to git** — `daemon/src/memory.ts:resolveBackend()` routes any write to a `PRIVATE_AGENT_FILES` filename (`persona.md`, `secrets.md`, `persona.json`, `secrets.json`) under any agent id to `localAgentDir(id)`. This path is `~/.claude/local-memory/agents/<id>/`, bind-mounted from the host. The git repo lives under `~/.claude/shared-specs/`, a different mount. There is no code path that crosses them.
- **Never returned over HTTP to a non-owner** — write requests under `agents/<id>/*` are 403'd unless `<id> ∈ OPENCLAW_LOCAL_AGENT_IDS`. Read requests for `persona.md` succeed only if the file exists locally; a follower asking the leader for "anubis's persona" gets a 404 because the leader's file system doesn't have it.
- **Never copied between machines automatically** — the daemon doesn't ship personas. If you migrate an agent, you scp the file yourself.

Things the system does **not** guarantee:

- That the operator hasn't intentionally pasted persona content into a Discord reply, a task description, or a memory file under `users/`. The privacy is structural, not semantic.
- That a malicious skill running inside the container can't `cat` the file. Container = same trust as the host shell. If you don't trust a skill, don't install it.

### Migration / decommission

When retiring a machine:

1. `docker compose down` on it.
2. Copy `~/.claude/local-memory/agents/<id>/persona.md` to wherever the agent is moving (encrypted channel — scp, password manager, signed envelope).
3. Wipe `~/.claude/local-memory/` on the old host (`shred -u ...` if the file was sensitive).
4. Rotate `DISCORD_TOKEN_<id>` if you suspect the old machine could still be online.
5. Remove `<id>` from the *new* machine's `OPENCLAW_LOCAL_AGENT_IDS` only after you're sure the persona file is in place.

The shared specs repo doesn't need any cleanup — the agent's `identity.md` (public bio) stays.

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
