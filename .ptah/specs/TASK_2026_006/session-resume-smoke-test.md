# Session-resume smoke test — Operator runbook (Batch 8d deliverable)

**Owner of execution:** the operator (NOT executed automatically; the dashboard executor cannot exercise this — see Rationale).
**Gate for:** Batch 10 cutover. Result MUST be recorded here before cutover proceeds.
**Source spec:** amendment-1 §16.7 (Restart UX flow) + risk #6 in `tasks.md`.

---

## Rationale — why this is operator-run, not automated

Amendment §16.7 promises that an openclaw chat session survives a gateway
restart (`docker restart openclaw-gateway`) and the next user message
continues with full context. This guarantee depends entirely on openclaw's
session-store persistence — code we don't own and can't fully unit-test.

We can't run this from the Batch 8d executor because:

1. The host stack today runs natively (host-native bot-bridge PID 2598,
   no docker compose), not the two-compose-service layout Batch 5b lands.
   `docker restart openclaw-gateway` therefore has no container to restart.
2. The post-Batch-5b test compose stack from `docker-compose.yml` is not
   currently up on this host.
3. The plugin (Batches 2/4/5/8c) is not yet loaded into the gateway — that
   happens at Batch 10 cutover.

Per `tasks.md` risk #6: "If session-resume is NOT working, this is a
MED-risk finding that must be surfaced to the user BEFORE batch 10 cutover."
This runbook is the surfaced gate.

---

## Prerequisites

Before running, confirm ALL of:

- [ ] `docker compose up -d` from repo root brings up `openclaw-gateway`,
      `openclaw-daemon`, `openclaw-redis`, all healthy (Batch 5b artifacts).
- [ ] `docker exec openclaw-gateway curl -fsS http://127.0.0.1:18789/health`
      returns 200.
- [ ] `docker exec openclaw-daemon curl -fsS http://127.0.0.1:7878/api/health`
      returns `{"ok":true,"leader":true,...}`.
- [ ] At least one persona Discord bot is online and reachable (e.g. Anubis;
      `.env` has a valid `DISCORD_TOKEN_ANUBIS`).
- [ ] You have access to send Discord DMs to that bot from a known account.
- [ ] You are NOT in a low-traffic Discord channel that other users actively
      depend on right now (test will momentarily kick the bot offline).

If any prerequisite is missing, STOP and address it. The test is invalid
otherwise.

---

## Test procedure

### Step 1 — Establish baseline session

1. DM the bot (e.g. `@anubis`) with a uniquely-identifiable seed:
   ```
   Test session — remember the phrase "purple koala 7B-2026". I'll ask you to recall it after a restart.
   ```
2. Wait for a reply that acknowledges the phrase. **Record the timestamp.**
3. In a separate shell, capture the gateway's session list as a sanity check:
   ```bash
   docker exec openclaw-gateway openclaw sessions list --json 2>/dev/null | jq -r '.[] | .id + " " + .agentId' | head -5
   ```
   Confirm at least one session row exists with the agent you DM'd.

### Step 2 — Restart the gateway

Run (in order):
```bash
# Primary path — CLI restart with 30s grace.
docker exec openclaw-gateway openclaw gateway restart
# If exit != 0 OR hangs beyond 30s, fall back:
# docker restart openclaw-gateway
```

Then watch the bot's Discord presence:
- Expected: bot goes offline briefly (5–15s), comes back online.
- **Hard fail** if offline >60s: openclaw didn't auto-reconnect.

Wait for `/health` to return 200 again:
```bash
until docker exec openclaw-gateway curl -fsS http://127.0.0.1:18789/health >/dev/null 2>&1; do sleep 1; done
echo "gateway healthy"
```

### Step 3 — Send follow-up referencing pre-restart context

DM the same bot:
```
What phrase did I ask you to remember?
```

### Step 4 — Assert context preservation

The reply should include `purple koala 7B-2026` (verbatim, or with trivial
formatting variation like quotes).

- **PASS:** reply contains the phrase. Session store survived restart.
- **FAIL — partial:** reply acknowledges the conversation but can't recall
  the phrase. Indicates message history loaded but model context window
  dropped. **MED-risk for Batch 10:** surface to user, decide whether to
  proceed.
- **FAIL — total:** reply treats the DM as a brand-new conversation
  ("I'm not sure what you mean", "What phrase?"). Session store is NOT
  persisting across restarts. **BLOCKER for Batch 10.**

---

## Record of result

> Operator: fill in below after running the procedure. Both the human
> observation and the raw timestamps are needed for the Batch 10 gate.

| Field | Value |
|---|---|
| Date run | `YYYY-MM-DD` |
| Operator handle | `@…` |
| Bot under test | `anubis` / `horus` / other |
| Gateway version | `docker exec openclaw-gateway openclaw --version` → … |
| Step 1 timestamp (seed sent) | |
| Step 2 timestamp (restart issued) | |
| Time to bot back online (seconds) | |
| Step 3 timestamp (follow-up sent) | |
| Reply included seed phrase? | YES / NO / PARTIAL |
| Overall result | PASS / FAIL-PARTIAL / FAIL-TOTAL |
| Notes | |

---

## What to do if it fails

### FAIL-TOTAL — session-store didn't persist

Do NOT proceed to Batch 10. Options:

1. Inspect the openclaw config block governing session persistence
   (`config/openclaw.json.tmpl` → `sessions.*` or equivalent). Confirm a
   durable store is configured (file-backed or redis-backed) and not the
   in-memory default.
2. If the config is correct, this is an upstream openclaw issue. Open an
   issue against the gateway repo with the version, the steps, and the
   captured timestamps. Pause Batch 10 until upstream confirms or we ship
   a workaround.
3. Workaround possibility: stub the test out of the Batch 10 gate and
   document the regression as a known limitation in `docs/CUTOVER_RUNBOOK.md`
   (Batch 9 deliverable). User decision required.

### FAIL-PARTIAL — message history yes, context no

Less severe but still surface. Likely cause: openclaw rehydrates the
session record but the LLM's working context window is rebuilt only from
the most recent N messages, and the seed got truncated. Acceptable for v1
if the operator agrees the UX impact is small; document in
`docs/TROUBLESHOOTING.md`.

### PASS — record and proceed

Update this file's "Record of result" table with PASS and the timestamps.
Reference the row in the Batch 10 pre-cutover gate checklist
(`docs/CUTOVER_RUNBOOK.md`). Batch 10 may proceed.

---

## Cross-reference

- amendment-1 §16.7 — the original UX flow this test validates.
- `tasks.md` Batch 8d acceptance criteria — bullet "Session-resume smoke
  test passes."
- `tasks.md` Risk #6 — the MED-risk surface this gate covers.
- `tasks.md` Batch 10 — the cutover that depends on this result.
