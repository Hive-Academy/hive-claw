# Follower setup — provisioning a second (Nth) machine

> **Audience:** the operator standing up a **follower** machine to host an
> additional persona (e.g. `horus`) alongside an already-running leader
> machine (e.g. the one hosting `anubis`).
>
> **Scope:** this is the post-TASK_2026_006 layout — three-service compose
> (`openclaw-gateway` + `openclaw-daemon` + `openclaw-redis`), openclaw-native
> multi-agent (no host bot-bridge process), per-persona Discord bot tokens.
>
> **Read order:** §1 prerequisites → §3 one-time setup → §5 verification.
> §2, §4, §6-§9 are reference material you'll skip back to. §10 lists where
> to go next.
>
> **Branch:** `ak/fix-internal-calls`. Do not commit from this doc.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Leader-vs-follower model — brief overview](#2-leader-vs-follower-model--brief-overview)
3. [One-time setup steps](#3-one-time-setup-steps)
4. [Persona ownership and routing](#4-persona-ownership-and-routing)
5. [Verifying the cross-machine link](#5-verifying-the-cross-machine-link)
6. [Per-persona Discord bot token guidance](#6-per-persona-discord-bot-token-guidance)
7. [Adding a third (or Nth) persona](#7-adding-a-third-or-nth-persona)
8. [Common pitfalls](#8-common-pitfalls)
9. [Health checks the operator should expect](#9-health-checks-the-operator-should-expect)
10. [Where to go next](#10-where-to-go-next)

---

## 1. Prerequisites

Before you start on the follower machine, confirm each item below.

### 1.1 On the follower host

| Requirement | Why |
|---|---|
| Docker Engine ≥ 24 | Runs the three-service compose stack. |
| Docker Compose plugin v2 (`docker compose ...`) | Required by `docker-compose.yml`. |
| `git` | To clone this repo. |
| `curl`, `jq`, `openssl` | Used by `entrypoint.sh` and manual verification curls. |
| Network reachability to the leader's daemon (`:7878` or a TLS-fronted URL) | Followers are HTTP-only clients of the leader. |
| `~/.claude/local-memory/agents/<persona>/persona.md` (writable) | Required for the persona to load — see §3.6. |
| `~/.ptah/` (writable) | Identity-bind-mounted into the container so the daemon and the host-side ptah-bridge share configs. |
| Node.js on the host (LTS 22.x recommended) | Required to run `scripts/ptah-bridge.mjs` host-side. |
| `gh` CLI **optional** | Only if this follower's persona will use GitHub MCP tooling. |

### 1.2 From the leader operator (or your own access to the leader machine)

You need three pieces of information off the leader before §3 can complete:

1. The leader's `OPENCLAW_INTERNAL_TOKEN` value (a 64-hex-char string). Copy it
   verbatim from the leader's `.env`. This is the bearer token every
   follower-to-leader call carries.
2. The leader's reachable URL. Either:
   - A LAN URL like `http://leader.lan:7878` (only if the leader's compose has
     `OPENCLAW_CONTROL_BIND=0.0.0.0` AND your network trusts that), or
   - A Tailscale Funnel URL like `https://leader.tailnet.ts.net` (the
     recommended public path — see `docs/SETUP.md` §7).
3. Confirmation that the leader's `agents.list[]` in
   `config/openclaw.json.tmpl` already declares the persona this follower
   will host. If not, the leader-side template needs an additional entry
   first — see §7.

### 1.3 A Discord bot for the persona this machine will host

One bot application per persona. You will obtain the bot token in §6 — but
you can do it before §3 if you'd prefer to have the token already in
clipboard when you edit `.env`.

---

## 2. Leader-vs-follower model — brief overview

The control plane is one leader plus zero or more followers. For depth see
`docs/ARCHITECTURE.md` §multi-machine-topology — this section is the
minimum context you need to follow §3.

The **leader** is exactly one machine in the fleet. It opens
`/data/specs.db` (SQLite, WAL mode), runs the continuation loop that walks
tasks through phases, and hosts the user-facing dashboard at `:7878`. Its
`.env` carries `OPENCLAW_LEADER=1`.

A **follower** is every other machine. Its daemon never opens a local DB —
it runs the same compiled binary as the leader, but in HTTP-client mode
against `OPENCLAW_LEADER_URL`. The follower's dispatch worker subscribes
to the leader's SSE stream (`/api/stream?topics=dispatch`), claims work
addressed to the agents it owns (`OPENCLAW_LOCAL_AGENT_IDS`), and reports
results back over HTTP. The follower's daemon validates at boot that
`OPENCLAW_LEADER_URL` is set when `OPENCLAW_LEADER=0` — config-load
hard-fail in `daemon/src/config.ts`.

Each persona connects to Discord with its **own** bot token. The leader's
openclaw signs in as `anubis`; the follower's openclaw signs in as
`horus`. Discord's gateway routes @mentions to whichever process holds
that bot's token — no cross-machine routing logic is required from us.
Cross-machine **handoff** lives in the SQLite spec store on the leader:
when anubis hands a task to horus, the leader updates `tasks.assigned_agent`
and the operator re-engages horus manually (see
`migration-architecture.md` §8.4 — auto-tickle is Phase 2).

---

## 3. One-time setup steps

Run each step on the follower machine. Steps are ordered — do not skip.

### 3.1 Clone the repo

```bash
git clone https://github.com/Hive-Academy/hive-claw ~/Desktop/fixing-openclaw
cd ~/Desktop/fixing-openclaw
git checkout ak/fix-internal-calls
```

If you already have a clone, ensure you are on the migration branch:

```bash
cd ~/Desktop/fixing-openclaw
git status                 # must be clean
git fetch origin
git checkout ak/fix-internal-calls
```

### 3.2 Copy `OPENCLAW_INTERNAL_TOKEN` off the leader

On the **leader** machine, read the value from `.env`:

```bash
grep '^OPENCLAW_INTERNAL_TOKEN=' .env
```

Treat the result as a secret. Transfer it to the follower out-of-band
(password manager, ephemeral encrypted message, scp from the leader to
the follower's home dir under `chmod 600`). Do **not** post it in chat,
do **not** commit it.

### 3.3 Decide on the leader's URL

Pick the URL the follower's daemon will use as `OPENCLAW_LEADER_URL`. The
choice is yours; common shapes:

- **Tailscale Funnel (recommended)**: `https://<leader>.<tailnet>.ts.net`.
  Public TLS termination, works through NAT, gated by Tailscale auth on
  the leader side. The leader operator runs `tailscale funnel --bg --https=443 7878`
  once on the leader.
- **LAN IP**: `http://192.168.1.42:7878` or `http://leader.lan:7878`. Only
  works if (a) the leader's compose has `OPENCLAW_CONTROL_BIND=0.0.0.0`,
  (b) the leader's host firewall allows your follower's source IP. Plain
  HTTP — only acceptable on a trusted LAN.
- **Reverse proxy (Caddy / Traefik / Cloudflare Tunnel)**: any TLS
  terminator pointing at the leader's `127.0.0.1:7878`.

Confirm reachability from the follower **before** writing it into `.env`:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' "<leader-url>/api/health"
# Expect: 200
```

A 200 without auth is expected for `/api/health` — the endpoint is
unauthenticated by design (`daemon/src/api.ts:153`).

### 3.4 Create the follower's `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Open `.env` in your editor and set the **follower-specific** variables.
The keys below are the minimum delta from `.env.example`; everything else
can stay at the template default.

```bash
# Leader/follower mode — REQUIRED on a follower
OPENCLAW_LEADER=0
OPENCLAW_LEADER_URL=https://leader.tailnet.ts.net      # the URL you verified in §3.3

# Service token — MUST match the leader's value byte-for-byte
OPENCLAW_INTERNAL_TOKEN=<paste the value from §3.2>

# This machine's agent ownership (single persona shown; CSV for multiple)
OPENCLAW_LOCAL_AGENT_IDS=horus

# Per-persona Discord bot token (uppercase id) — see §6
DISCORD_TOKEN_HORUS=<bot token from Discord Developer Portal>

# Host home for identity-bind-mounted ptah path. MUST be a real path on
# this host (the daemon's materialize.ts emits paths under this prefix).
OPENCLAW_HOST_HOME=/home/<your-user>

# Inference provider (gateway tier). Same shape as the leader.
LLM_PROVIDER=ollama
LLM_MODEL=kimi-k2.6:cloud
OLLAMA_BASE_URL=http://host.docker.internal:11434/v1

# ptah-bridge URL — keep the default; bridge runs on the host
OPENCLAW_PTAH_BRIDGE_URL=http://host.docker.internal:8744

# Discord OAuth (dashboard login) — followers usually leave empty. The
# follower's loopback dashboard then falls back to a `local-dev` user,
# which is fine because the follower's dashboard is for local debug only.
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Optional: only if you want the leader's bot token in this machine's
# config for some reason. Normally leave empty on a follower — the
# follower's openclaw will NOT have that persona's binding active.
DISCORD_TOKEN_ANUBIS=
```

**Hard-fails to know about** before you run compose:

- If `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL` is empty, the daemon
  refuses to start (`daemon/src/config.ts:9-13`). Set the URL.
- If `OPENCLAW_INTERNAL_TOKEN` is empty on a follower, every relay call to
  the leader will 401. The token must match the leader exactly.

Leave `OPENCLAW_SPECS_DB_PATH=/data/specs.db` at the default. The follower
never opens the file; the value is harmless and the compose volume is
empty on followers.

### 3.5 Verify the leader declares this persona

On the leader machine, confirm the persona this follower will host is in
the gateway template:

```bash
grep -A1 '"agents"' config/openclaw.json.tmpl | head -20
```

If the persona is missing from `agents.list[]`, follow §7 first on the
leader and redeploy the leader. The follower cannot meaningfully run a
persona the leader's spec store doesn't know about.

### 3.6 Scaffold the persona's local memory

The bot-bridge / openclaw skips any agent whose
`local-memory/agents/<id>/persona.md` file is missing (the persona-privacy
chokepoint in `daemon/src/memory.ts`). Create the file from the template:

```bash
mkdir -p ~/.claude/local-memory/agents/horus
cp templates/agent-persona.md.tmpl ~/.claude/local-memory/agents/horus/persona.md
chmod 600 ~/.claude/local-memory/agents/horus/persona.md
$EDITOR ~/.claude/local-memory/agents/horus/persona.md
```

Edit at least the name, role, voice, scope, do/don't sections. This file
is **never** synced to the leader, never written to the leader's DB, never
sent over HTTP. It lives only on this machine, by design (see
`docs/SECURITY.md` §persona-privacy-invariant).

### 3.7 Install the host-side ptah-bridge

The plugin's `invoke_ptah` tool routes orchestration work through a
host-side shell wrapper (`scripts/ptah-bridge.mjs`), reached at
`host.docker.internal:8744`. The bridge runs on the **host**, not in
the container, so it has direct access to the host's claude-cli auth
state under `~/.claude/`.

You have two options.

**Option A — systemd user service (recommended).** Persistent, auto-restarts.

```bash
mkdir -p ~/.config/systemd/user
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
PTAH_BIN="$(command -v ptah || echo /usr/local/bin/ptah)"
TOKEN="$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)"

sed \
  -e "s|{{REPO_DIR}}|$(pwd)|g" \
  -e "s|{{TOKEN}}|${TOKEN}|g" \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{NODE_DIR}}|${NODE_DIR}|g" \
  -e "s|{{PTAH_BIN}}|${PTAH_BIN}|g" \
  scripts/ptah-bridge.service.tmpl \
  > ~/.config/systemd/user/ptah-bridge.service

systemctl --user daemon-reload
systemctl --user enable --now ptah-bridge.service
systemctl --user status ptah-bridge.service     # should be active (running)
```

Logs: `journalctl --user -u ptah-bridge.service -f`.

**Option B — manual launch (development / one-off).** Foreground process,
dies on terminal close.

```bash
export OPENCLAW_INTERNAL_TOKEN="$(grep '^OPENCLAW_INTERNAL_TOKEN=' .env | cut -d= -f2-)"
export PTAH_BRIDGE_HOST=0.0.0.0
export PTAH_BRIDGE_PORT=8744
node scripts/ptah-bridge.mjs
```

Smoke test (from the follower host, separate terminal):

```bash
curl -fsS -H "Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}" \
     http://127.0.0.1:8744/health
# Expect a 200 with a JSON body (the bridge's health endpoint).
```

The bridge listens on `0.0.0.0:8744` by design so the openclaw container
can reach it via `host.docker.internal:8744`. The bearer-token gate
(`OPENCLAW_INTERNAL_TOKEN` — same value, single source of truth) is the
only thing preventing arbitrary local processes from invoking it; on a
multi-tenant host, add a firewall rule restricting `:8744` to the docker
bridge subnet (typically `172.17.0.0/16`).

### 3.8 Authenticate `gh` and `ptah` on the host (optional)

If the persona's harness lists the GitHub MCP server or any ptah-driven
orchestration, authenticate on the **host** so the bind-mounted configs
are populated before the container starts:

```bash
gh auth login           # writes ~/.config/gh/hosts.yml (bind-mounted into the container, read-only)
ptah auth login         # writes ~/.ptah/ (bind-mounted into the container, read-write)
```

`gh auth login` only persists state inside `~/.config/gh/` when
`GH_AUTH_MODE=file` (the `.env.example` default). The `keyring` mode does
NOT cross the container boundary.

### 3.9 Build the image

```bash
docker compose build
```

This builds `openclaw-local:latest`, which is used by both the
`openclaw-gateway` and `openclaw-daemon` services. Same image, different
`OPENCLAW_CONTAINER_ROLE` env var picks the boot path in `entrypoint.sh`.
Expect a few minutes on a cold build (Node 22 base + the openclaw npm
install).

### 3.10 Bring the stack up

```bash
docker compose up -d
docker compose ps
```

Expect three containers: `openclaw-gateway`, `openclaw-daemon`,
`openclaw-redis`. All three should reach state `Up (healthy)` within
~60-90 seconds. Watch the boot:

```bash
docker compose logs -f openclaw-daemon openclaw-gateway
```

On a clean boot the daemon logs `leader: false` and the gateway logs the
rendered `openclaw.json` with the persona's Discord account active. See
§9 for the health-check response shape.

### 3.11 First verification

```bash
# Daemon health (loopback)
curl -fsS http://127.0.0.1:7878/api/health | jq .

# Gateway health (loopback)
curl -fsS http://127.0.0.1:18789/health
```

If the daemon's `/api/health` returns `{"ok":true,"leader":false,"localAgentIds":["horus"], ...}`,
the follower is up. If `leader` is `true`, you misconfigured `OPENCLAW_LEADER`.

Then in your Discord guild: `@Horus ping`. Horus should reply within 30
seconds (cloud-model latency dominates). Persona name and tone come from
the `persona.md` you edited in §3.6.

---

## 4. Persona ownership and routing

`OPENCLAW_LOCAL_AGENT_IDS` is the **only** thing that picks which personas
this machine actually runs. The value is a CSV of agent ids, e.g.:

```bash
OPENCLAW_LOCAL_AGENT_IDS=horus
# or multiple personas owned by this machine:
OPENCLAW_LOCAL_AGENT_IDS=horus,chappie
```

Two things are independent of this env var, and they need to be set
elsewhere:

1. **The gateway template** (`config/openclaw.json.tmpl`) declares **all**
   personas in `agents.list[]` and configures each persona's Discord bot
   account under `channels.discord.accounts.<persona>`. The template is
   the same on every machine in the fleet (it's a checked-in file, post
   Batch 6 ships `anubis` + `horus` by default).
2. **The Discord bot token** for a persona must be set in the `.env` of
   the machine that runs that persona, as `DISCORD_TOKEN_<UPPER_ID>`. The
   other machines leave that token empty (or omit the variable entirely).

**Auto-scoping at render time:** `entrypoint.sh`'s `render_template()`
function filters `agents.list[]`, `channels.discord.accounts`, and
`bindings[]` down to only the IDs in `OPENCLAW_LOCAL_AGENT_IDS` before
openclaw sees the rendered `~/.openclaw/openclaw.json`. So on the
follower hosting `horus`, the rendered config contains **only** horus
— no empty-token anubis account, no dead binding. The shared template
in git remains the fleet-wide source of truth; per-machine rendering
narrows it.

The combination matters:

- If `OPENCLAW_LOCAL_AGENT_IDS` does not include `horus` on this machine,
  the rendered `openclaw.json` won't have a horus entry at all, AND the
  daemon's ownership checks 403 any write to `agents/horus/*` in shared
  memory.
- If `OPENCLAW_LOCAL_AGENT_IDS=horus` but `DISCORD_TOKEN_HORUS` is empty,
  the rendered config has horus's account with an empty token; openclaw
  boots fine but Horus shows as offline in Discord.
- If `OPENCLAW_LOCAL_AGENT_IDS=horus` is set on **two** machines and both
  have `DISCORD_TOKEN_HORUS` set to the same value, Discord rejects the
  second connect attempt (one bot, one running instance). Effect: a
  flapping bot. Never run the same persona on two machines simultaneously.
- If `OPENCLAW_LOCAL_AGENT_IDS` is empty/unset, the filter is **skipped**
  entirely — useful for legacy / single-machine dev mode where you want
  the full template active.

The rule of thumb: the union of `OPENCLAW_LOCAL_AGENT_IDS` values across
the fleet must equal the set of personas in `agents.list[]`, and the
intersection of any pair must be empty.

---

## 5. Verifying the cross-machine link

Run these from inside the follower's daemon container (so the bearer
token is already in the environment).

### 5.1 Reach the leader's health endpoint

```bash
docker compose exec openclaw-daemon curl -fsS \
  -H "Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}" \
  "${OPENCLAW_LEADER_URL}/api/health" | jq .
```

Expected: `{"ok":true,"leader":true, ...}`. Note the leader's `dbVersion`
field — the follower's own `/api/health` reports the same `dbVersion`
value, fetched via `readLeaderDbVersion()` in
`daemon/src/leaderClient.ts:719-724`.

Failure modes:

- HTTP 401: `OPENCLAW_INTERNAL_TOKEN` mismatch. Re-copy from the leader.
- Connection refused / DNS error: the URL is wrong, the leader's
  `OPENCLAW_CONTROL_BIND` is loopback-only, or the TLS terminator is down.
- HTTP 502/504: the leader's daemon is unhealthy on its end. Check
  `docker compose logs openclaw-daemon` on the leader.

### 5.2 List projects from the follower

```bash
docker compose exec openclaw-daemon curl -fsS \
  -H "Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}" \
  http://127.0.0.1:7878/api/projects | jq .
```

Expected: an array of projects from the leader's SQLite store, relayed
via `storage.ts` → `leaderClient.ts`. Empty array is fine if no projects
exist yet — the call type-checked and the relay round-tripped.

### 5.3 Subscribe to the leader's dispatch SSE

```bash
docker compose exec openclaw-daemon curl -sS \
  -H "Authorization: Bearer ${OPENCLAW_INTERNAL_TOKEN}" \
  -N "${OPENCLAW_LEADER_URL}/api/stream?topics=dispatch" | head -20
```

Expected: a stream that prints `:` heartbeats and an initial
`event: dispatch.snapshot` or similar. Cancel with Ctrl-C after a few
lines. If the stream closes immediately with HTTP 401 or 403, the token
is wrong.

### 5.4 Create a task addressed to the follower's persona

On the leader's dashboard (or via Discord on the leader, `@Anubis !task`
flow), create a task in any project and **handoff** to the follower's
persona (e.g. `horus`). Within seconds the follower's daemon logs should
show:

```
[dispatch-worker] received dispatch.pending event for agentId=horus
[dispatch-worker] claimed dispatch <id>
```

If it doesn't, see §8 row "follower never claims a dispatch".

---

## 6. Per-persona Discord bot token guidance

One Discord application per persona. Each application has its own bot
account, its own token, and shows up in your guild as its own user.
Discord's developer portal is the canonical source — this section
condenses the steps.

1. Go to <https://discord.com/developers/applications>, click **New
   Application**, name it after the persona (e.g. `horus`).
2. Sidebar → **Bot** → enable:
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
   - `PUBLIC BOT` → **off** (so others can't add your bot to their
     servers).
3. **Bot → Reset Token** → copy. This is the value for
   `DISCORD_TOKEN_<UPPER_ID>` in this machine's `.env`. The token is shown
   once — copy immediately.
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`.
   - Bot permissions: `View Channels`, `Send Messages`,
     `Read Message History`. (Add `Attach Files` only if the persona
     uploads attachments.)
   - Open the generated URL in a browser, select your guild, authorize.
5. After invite, the bot appears as an offline user in your guild
   member list. It comes online when the follower's openclaw signs in
   with the token (after §3.10).

Each persona has its own bot, its own token, its own presence. There is
no shared bot account. This is intentional — easier to revoke a single
token, no Discord rate-limit collisions between personas, presence is
per-agent.

---

## 7. Adding a third (or Nth) persona

There are two scopes of change.

### 7.1 Leader-side (one-time, propagates to all followers)

Edit `config/openclaw.json.tmpl` to add the new persona's entries. The
template is the same file on every machine — it is a checked-in source
file. Bump three blocks:

```jsonc
"agents": {
  "list": [
    { "id": "anubis", "default": true, "workspace": "/home/agent/.openclaw/workspace/anubis" },
    { "id": "horus",  "workspace": "/home/agent/.openclaw/workspace/horus"  },
    { "id": "newpersona", "workspace": "/home/agent/.openclaw/workspace/newpersona" }
  ]
},
"channels": {
  "discord": {
    "accounts": {
      "newpersona": {
        "token": "${DISCORD_TOKEN_NEWPERSONA}",
        "enabled": true,
        "name": "NewPersona",
        "healthMonitor": { "enabled": true }
      }
    }
  }
},
"bindings": [
  { "agentId": "newpersona", "match": { "channel": "discord", "accountId": "newpersona" } }
]
```

Add `DISCORD_TOKEN_NEWPERSONA=` to `.env.example` as a documented empty
default and rebuild every machine's image (`docker compose build`). Until
the new template propagates, follower machines hosting `newpersona` will
not render the binding.

`entrypoint.sh`'s `envsubst` allow-list must mention any new variable
name, or `envsubst` will leave the literal `${DISCORD_TOKEN_NEWPERSONA}`
in the rendered config (see `docs/CONFIGURATION.md` §entrypoint.sh).

**You do NOT need to do anything per-machine to "remove" the new persona
from machines that don't host it.** `entrypoint.sh`'s render-time
filter (see §4 "Auto-scoping at render time") automatically drops the
new persona from every machine whose `OPENCLAW_LOCAL_AGENT_IDS` doesn't
include `newpersona`. Each machine's `~/.openclaw/openclaw.json` ends
up containing only its own personas.

### 7.2 Per-follower (only on the machine hosting the new persona)

On the machine that will host `newpersona`:

```bash
# 1. Add to OPENCLAW_LOCAL_AGENT_IDS
sed -i 's/^OPENCLAW_LOCAL_AGENT_IDS=.*/OPENCLAW_LOCAL_AGENT_IDS=newpersona/' .env
# (or, if this machine already hosts other personas, append: "horus,newpersona")

# 2. Add the bot token
echo 'DISCORD_TOKEN_NEWPERSONA=<bot token>' >> .env

# 3. Scaffold persona.md
mkdir -p ~/.claude/local-memory/agents/newpersona
cp templates/agent-persona.md.tmpl ~/.claude/local-memory/agents/newpersona/persona.md
$EDITOR ~/.claude/local-memory/agents/newpersona/persona.md

# 4. Rebuild + restart
docker compose build
docker compose up -d
```

Other followers — leave `DISCORD_TOKEN_NEWPERSONA` empty. The persona's
binding still renders in their `openclaw.json` but with an empty token
that openclaw will fail to sign in and log; the rendered config still
validates, no impact on the personas that machine does host.

---

## 8. Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Daemon hard-fails at boot: `Followers MUST set OPENCLAW_LEADER_URL` | `OPENCLAW_LEADER=0` and `OPENCLAW_LEADER_URL` is empty (`daemon/src/config.ts:9-13`). | Set `OPENCLAW_LEADER_URL` in `.env`; `docker compose up -d`. |
| Every relay call returns HTTP 401 | `OPENCLAW_INTERNAL_TOKEN` does not match the leader's value byte-for-byte. | Re-copy from leader `.env`; restart the daemon. Whitespace and trailing newlines bite. |
| Persona appears offline in Discord even though the container is healthy | `DISCORD_TOKEN_<UPPER_ID>` is empty or invalid. | Verify the token in Developer Portal; the bot's invite covers the guild; re-paste into `.env`; restart. |
| `@<persona> ping` works on Anubis but Horus is silent | This machine hosts only the persona in `OPENCLAW_LOCAL_AGENT_IDS`. The other persona's bot is running on a different machine. | This is the design. Send `@Horus ping` instead. |
| Plugin tool calls fail with `connection refused` / `ECONNREFUSED 8744` | Host-side ptah-bridge isn't running. | Check `systemctl --user status ptah-bridge.service` (or whatever launched it in §3.7). Start it. |
| Plugin tool calls fail with `EHOSTUNREACH` to `host.docker.internal` | Docker on Linux didn't add the `host.docker.internal` mapping. | Confirm `extra_hosts: ["host.docker.internal:host-gateway"]` is in `docker-compose.yml` (it is in both `openclaw-gateway` and `openclaw-daemon` post-Batch-5b). |
| Bot-bridge logs `[bot-bridge] agent "<id>" has no local persona — skipping` | `~/.claude/local-memory/agents/<id>/persona.md` missing or unreadable. | Re-run §3.6; check file mode (must be readable by uid 1000 inside the container). |
| `403` writing to `agents/horus/*` in shared memory | `horus` not in `OPENCLAW_LOCAL_AGENT_IDS` on this machine — the ownership check in `daemon/src/memory.ts` refuses. | Add `horus` to the env var; restart. (This is also the right answer when migrating ownership between machines.) |
| Same persona online on two machines (presence flapping) | `DISCORD_TOKEN_<UPPER_ID>` set on two machines, or `OPENCLAW_LOCAL_AGENT_IDS` overlaps. | Pick one machine; clear the token on the other; restart both. |
| Follower never claims a dispatch | SSE subscription broken, or token wrong, or persona not in `OPENCLAW_LOCAL_AGENT_IDS`. | Run §5.3 — if 401, fix the token. If stream is fine but no dispatch events arrive, verify the leader has the assignment with `sqlite3 /data/specs.db "SELECT id,assigned_agent FROM tasks WHERE id='<task>'"`. |
| Clock skew warnings, dispatches show out-of-order timestamps | Host clock drift between leader and follower. SQLite stores timestamps with `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — the leader's clock wins for `claimed_at`, but the follower's log timestamps will look weird. | `timedatectl set-ntp true` on both hosts. Leader and follower should agree to within a second. |
| Materialized ptah configs missing or written to wrong path | `OPENCLAW_HOST_HOME` doesn't match the actual host home, so the identity-bind-mount `${OPENCLAW_HOST_HOME}/.ptah:${OPENCLAW_HOST_HOME}/.ptah:rw` lands on a path neither side has. | Set `OPENCLAW_HOST_HOME` to your real `$HOME`; `docker compose up -d`. |
| Daemon refuses to boot with `dbVersion` complaint on a follower | Followers do not run migrations. The leader's `dbVersion` is probed via HTTP; if the leader is mid-upgrade, the follower may flag a mismatch. | Wait for the leader to finish booting; restart the follower. |
| Dashboard at `:7878` returns `local-dev` user without prompting | This is the loopback fallback when `DISCORD_CLIENT_ID` is empty. Fine on a follower used only for local debug; do **not** expose the follower's dashboard publicly. | Either set Discord OAuth credentials on the follower (rare) or keep the dashboard on loopback. |

For pitfalls common to all installs (Ollama, Docker, gateway-tier
issues), see `docs/SETUP.md` §Common-pitfalls-on-first-install and
`docs/TROUBLESHOOTING.md`.

---

## 9. Health checks the operator should expect

### 9.1 Follower daemon health

```bash
curl -fsS http://127.0.0.1:7878/api/health | jq .
```

Expected body on a healthy follower (shape per `daemon/src/api.ts:153-173`):

```json
{
  "ok": true,
  "ts": "2026-05-12T18:42:11.000Z",
  "leader": false,
  "localAgentIds": ["horus"],
  "storage": "leader-http",
  "dbVersion": 4
}
```

What each field tells you:

- `ok: true` — the Fastify process is up.
- `leader: false` — confirms this machine is a follower. If `true`, your
  `.env` has `OPENCLAW_LEADER=1` and you'll fight the leader for the DB.
- `localAgentIds` — the parsed CSV from `OPENCLAW_LOCAL_AGENT_IDS`.
  Verify it lists the personas you expect this machine to host.
- `storage: "leader-http"` — the storage facade is in HTTP-relay mode.
  On the leader this value is `"db"`.
- `dbVersion` — fetched from the leader via `readLeaderDbVersion()`. If
  this field is absent on a follower, the relay call to the leader is
  failing — go to §5.1.

The `dbPath` field is **omitted** on followers by design — they do not
have a local DB. If you see it, your follower thinks it's a leader.

### 9.2 Follower gateway health

```bash
curl -fsS http://127.0.0.1:18789/health
```

Expected: HTTP 200 with a small body from the openclaw gateway. The
gateway has no leader/follower mode — it just runs openclaw with the
rendered `openclaw.json` and signs into whichever Discord bot accounts
have non-empty tokens.

### 9.3 Follower's persona answering on Discord

The end-to-end check: `@<persona> ping` in your guild. Reply within ~30
seconds (cloud-model latency dominates). If silent, see §8.

### 9.4 Cross-machine relay (mandatory)

§5.1 must pass before you call the follower healthy. A daemon that's
"up" but can't reach the leader is a non-functional follower — its
dispatch worker has nothing to do.

---

## 10. Where to go next

- `docs/ARCHITECTURE.md` — the deeper view of leader/follower topology,
  the SQLite linearization point, and the SSE event taxonomy.
- `docs/OPERATIONS.md` — daily SQL one-liners, backups, schema dump,
  disaster recovery, SSE event taxonomy. Read this before you have an
  incident, not during.
- `docs/CONFIGURATION.md` — every env var, with line-number references
  into `daemon/src/config.ts`.
- `docs/TROUBLESHOOTING.md` — the symptom-to-fix lookup table.
- `docs/SECURITY.md` — the persona-privacy invariant and the four
  defense layers that enforce it.
- `docs/CUTOVER_RUNBOOK.md` — only relevant if you are doing the
  TASK_2026_006 Batch 10 cutover from the host-native bot-bridge to the
  openclaw-native multi-agent layout. Skip if your install is already
  post-Batch-6.

When code disagrees with this doc, code wins — open a PR.

---

**End of FOLLOWER_SETUP.md.**
