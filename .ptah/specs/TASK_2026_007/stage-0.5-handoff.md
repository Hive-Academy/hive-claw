# TASK_2026_007 — Stage 0.5 handoff

**Status:** code landed on `main`, ready for first end-to-end dispatch test.
**Scope:** the dispatcher-side worktree hook + container plumbing so a
dispatched agent can land in a real git working dir on a per-task branch
and finish with a PR. Stage A `export_to_project` and Stage B's five
daemon-mediated git RPCs from `design.md` are **deferred** — we shipped a
narrower path that uses the agent's existing tool surface (Bash, Edit, gh
MCP write tools) instead of building a new RPC layer.

## Why "Stage 0.5"

The TASK_2026_006 diary entry (anubis wrote 6 SEO files for code-valley
but had no commit path) named the missing piece as "no path from agent
workspace → repo." The `design.md` proposal answered with Stage A (manual
operator handoff) or Stage B (5 typed daemon RPCs + encrypted credentials
+ validation whitelist + worktree lifecycle table).

In conversation it became clear that:

1. Anubis's **orchestration tier** already runs ptah-cli (full Claude
   Code surface) on the host with arbitrary `cwd` and the `gh` MCP
   server. He has Bash, Edit, git, and `create_pull_request` available.
   The TASK_006 diary problem was on the **chat tier**, not the
   orchestration tier.
2. The `@modelcontextprotocol/server-github` MCP already exposes
   `create_or_update_file`, `push_files`, `create_branch`, and
   `create_pull_request` — the agent just needs a write-scoped PAT.
3. A per-task git worktree under the project's clone gives parallel-task
   isolation + a clean branch for free, using git's own mechanism
   instead of a custom worktrees table.

Stage 0.5 wires (3) into the dispatcher so the agent never has to think
about worktree mechanics. Combined with operator-side PAT rotation
(below), this gets the SEO/code-valley loop running end-to-end without
building Stage B's RPC layer.

## What shipped (file-by-file)

| File | Change |
|---|---|
| `openclaw-control/daemon/src/db/schema.ts` | `CURRENT_VERSION = 4`; new `SCHEMA_V4` adding `github_repo` and `default_branch` columns to `projects`. |
| `openclaw-control/daemon/src/db/migrations.ts` | New `applyV4` step. Idempotent ALTER TABLEs inside a transaction. |
| `openclaw-control/daemon/src/db/projects.ts` | `ProjectsRepo` reads/writes `github_repo` + `default_branch`. `ProjectRow.githubRepo` / `defaultBranch` are nullable. `UpsertProjectInput` gains both as optional. |
| `openclaw-control/daemon/src/projects.ts` | Canonical `Project` interface gains `githubRepo` + `defaultBranch` (required-but-nullable). `discoverProjects` / `getProject` / `ensureProject` thread the new fields through. |
| `openclaw-control/daemon/src/leaderClient.ts` | Follower-side `readProject` synthesis returns nulls for the new fields. v0 is **leader-only**; followers behave as pre-Stage-0.5 (no worktree). |
| `openclaw-control/daemon/src/harness/worktree.ts` *(new)* | `setupWorktree(project, agentId, taskId)` — pure helper. Returns `{cwd, branch, worktreePath, note}`. Skips when `githubRepo` is null or `path` isn't a git working dir. Idempotent across retries (existing worktree → reuse, existing branch → reuse via `worktree add <path> <branch>` without `-b`). Failure modes degrade to "use project root as cwd" with a logged note — never fail the dispatch. |
| `openclaw-control/daemon/src/invoker.ts` | Calls `setupWorktree` between the inflight-lock and `spawnPtahForAgent`. Logs the note to dispatch_log; broadcasts `invoker.worktree` SSE event with `{taskId, agentId, path, branch}`. Passes `wt.cwd` to ptah instead of `project.path`. |
| `Dockerfile` | Added `git` to the apt-get install list. Daemon container previously had `gh` but no `git` binary — `git worktree add` would have failed with ENOENT. |
| `docker-compose.yml` | New identity bind mount on `openclaw-daemon`: `${OPENCLAW_PROJECTS_DIR:-${HOME}/projects}:${OPENCLAW_PROJECTS_DIR:-${HOME}/projects}:rw`. Same-path-both-sides so the daemon's `git worktree add` and ptah's host-side `cwd` resolve to the same files. |
| `shared-specs/memory/agents/anubis/identity.md` | New section "Dispatched against a github-backed project" — explicit workflow contract: edit → validate → commit (with path allowlist) → push → PR via gh MCP. Includes the not-allowed list. |

## What this does NOT do (intentional)

- **No auto-cleanup on task DONE.** Phase transitions in this codebase are
  file-derived (no explicit `updatePhase('DONE')` chokepoint to hook).
  Auto-cleanup would need a transition detector inside
  `TasksRepo.writeFile` — out of scope for v0. Worktrees + branches
  persist after DONE, which is actually useful for operator review.
- **No dashboard form for the new columns.** Project registration with
  `github_repo` / `default_branch` is via SQL UPDATE today. Adding the
  fields to the dashboard's Projects page form is a one-PR follow-up.
- **No `/api/projects` exposure of the new fields** to followers.
  `leaderClient.readProject` returns `null` for both fields so followers
  take the pre-worktree code path. Extending `/api/projects` is a
  follow-up if multi-machine worktrees are needed.
- **No validation gate.** The agent commits and pushes; branch protection
  + required PR review on the GitHub side replaces Stage B's
  `run_validation` whitelist.
- **No encrypted credentials table.** PAT lives in `GITHUB_TOKEN` env var
  passed through to the gh MCP server. Fine-grained PAT scoped to
  specific repos limits blast radius. Stage B's `project_credentials`
  AES-GCM table is a follow-up if threat model demands it.
- **Path allowlist on commits enforced by the agent**, not by daemon
  code. `commit_files`-style server-side path validation is deferred —
  documented in `identity.md` as a hard rule.

## Operator steps before testing

1. **Pre-clone the test repo on the host.**
   ```bash
   mkdir -p ~/projects
   cd ~/projects
   gh repo clone Hive-Academy/code-valley
   gh auth setup-git
   ```
   The gh login must use a PAT (or fine-grained PAT) with
   **Contents: read+write** + **Pull requests: read+write** for the
   target repo. If the current login is read-only, do
   `gh auth login` with a new fine-grained PAT first.

2. **Set `GITHUB_TOKEN` in `.env`** to the same write-capable PAT. The
   gh MCP server reads `GITHUB_PERSONAL_ACCESS_TOKEN`, which is wired
   from `${GITHUB_TOKEN}` in `shared-specs/memory/agents/anubis/harness.yaml:101`.

3. **(Optional) Set `OPENCLAW_PROJECTS_DIR`** in `.env` if you want a
   path other than `${HOME}/projects`:
   ```
   OPENCLAW_PROJECTS_DIR=/some/other/path
   ```

4. **Rebuild and restart the daemon container.**
   ```bash
   cd /home/anubis/Desktop/fixing-openclaw
   docker compose up -d --build openclaw-daemon
   ```
   The image rebuild picks up the new daemon `dist/` (including
   `harness/worktree.js`) and the new `git` apt package. The daemon's
   entrypoint runs migrations on boot — schema v4 ALTERs land
   automatically.

   Watch logs:
   ```bash
   docker compose logs -f openclaw-daemon | head -50
   # expect: "migrations applied: schema_version=4 db=/data/specs.db"
   ```

5. **Register the project in the DB.** No dashboard form yet:
   ```bash
   docker compose exec openclaw-daemon \
     sqlite3 /data/specs.db \
     "INSERT INTO projects (slug, name, workspace, github_repo, default_branch)
      VALUES ('code-valley', 'code-valley', '$HOME/projects/code-valley', 'Hive-Academy/code-valley', 'main')
      ON CONFLICT(slug) DO UPDATE SET
        workspace = excluded.workspace,
        github_repo = excluded.github_repo,
        default_branch = excluded.default_branch;"
   ```
   The `$HOME` expansion happens in the host shell. The inserted
   `workspace` must equal the host path AND be visible inside the
   container — the identity mount guarantees this when
   `OPENCLAW_PROJECTS_DIR` matches.

   Verify:
   ```bash
   docker compose exec openclaw-daemon \
     sqlite3 /data/specs.db \
     "SELECT slug, workspace, github_repo, default_branch FROM projects WHERE slug='code-valley';"
   ```

## Test plan

### Test 1 — daemon picks up the new schema + binary

**Setup:** complete operator steps 1–4 above.

**Verify:**
```bash
# Schema version
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "SELECT MAX(version) FROM schema_version;"
# expect: 4

# New columns exist
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "PRAGMA table_info(projects);"
# expect rows for github_repo and default_branch

# Worktree module is in the dist
docker compose exec openclaw-daemon \
  node -e "console.log(require('fs').existsSync('/opt/openclaw-control/daemon/dist/harness/worktree.js'))"
# expect: true

# git is available
docker compose exec openclaw-daemon git --version
# expect: git version 2.x

# Bind mount is live
docker compose exec openclaw-daemon ls -la "$HOME/projects/code-valley/.git" 2>&1 | head -3
# expect: a real .git directory listing, not "No such file"
```

### Test 2 — dispatch creates a worktree

**Setup:** complete operator step 5 (project registered).

Dispatch a task assigned to `anubis` against `code-valley`. Either via
the dashboard's Tasks → Dispatch button, or via the bot-bridge's
`dispatch_orchestration_task` tool by DMing anubis in Discord. Pick a
task that already has `task-description.md` + `implementation-plan.md`
so the continuation loop's IMPLEMENT-equivalent phase fires.

**Verify during/after the dispatch:**
```bash
# Dispatch log shows the worktree note
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "SELECT message FROM dispatch_log
   WHERE dispatch_id = (SELECT id FROM dispatches
                        WHERE project_slug='code-valley' ORDER BY created_at DESC LIMIT 1)
   ORDER BY ts ASC;"
# expect a line: "worktree created at .../.worktrees/<task-id> (new branch agent/anubis/<task-id> from main)"

# git sees the worktree on the host
cd ~/projects/code-valley
git worktree list
# expect a row for .worktrees/<task-id> on branch agent/anubis/<task-id>

# SSE stream broadcasts invoker.worktree (in another terminal during dispatch)
curl -N "http://127.0.0.1:7878/api/stream?topics=invoker" \
  -H "Authorization: Bearer $OPENCLAW_INTERNAL_TOKEN"
# expect: event: invoker.worktree
#         data: {"taskId":"...","agentId":"anubis","path":"...","branch":"agent/anubis/..."}
```

### Test 3 — agent finishes with a PR

**This is the acceptance test.** Anubis needs to:
1. Edit at least one file in his worktree.
2. Run validation (e.g. `npm install && npm test` or `npm run build`).
3. `git add <paths> && git commit -m "..."`.
4. `git push -u origin <branch>`.
5. Open a PR via the `gh` MCP server's `create_pull_request` tool.
6. Report the PR URL in his final dispatch output.

**Verify:**
```bash
# Branch is on GitHub
gh api "repos/Hive-Academy/code-valley/branches/agent/anubis/<task-id>" | jq .name

# PR exists
gh pr list --repo Hive-Academy/code-valley --head agent/anubis/<task-id>
```

The PR opens against `main` (or the project's `default_branch`).
Branch protection should require review — verify no auto-merge happened.

### Test 4 — idempotency on retry

If a dispatch fails mid-run and the continuation loop dispatches the
same task again:

**Verify the worktree is reused, not recreated.**
```bash
# Dispatch the same task again (via dashboard or curl)
# Then check the log:
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "SELECT message FROM dispatch_log
   WHERE dispatch_id = (SELECT id FROM dispatches
                        WHERE project_slug='code-valley' AND task_id='<task-id>'
                        ORDER BY created_at DESC LIMIT 1)
   AND message LIKE 'worktree %';"
# expect: "worktree reused at ..." NOT a fresh "worktree created at ..."
```

### Test 5 — back-compat (non-github project)

Register a second project without `github_repo`:
```bash
docker compose exec openclaw-daemon sqlite3 /data/specs.db \
  "INSERT INTO projects (slug, name, workspace) VALUES ('legacy-test', 'legacy-test', '/tmp/legacy-test');"
```

Dispatch a task on it. **Verify:**
- Dispatch log shows: `worktree skipped: project.githubRepo is null (non-github project)`.
- The dispatch otherwise behaves identically to pre-Stage-0.5 (cwd = `/tmp/legacy-test`).
- No errors.

## Failure modes to expect

| Symptom | Likely cause | Fix |
|---|---|---|
| `worktree skipped: <path> is not a git working dir` | Bind mount didn't land, or the host clone is at a different path than `projects.workspace`. | `docker compose exec openclaw-daemon ls -la $HOME/projects/code-valley/.git` — if missing, check `OPENCLAW_PROJECTS_DIR` and rebuild. |
| `worktree creation failed: fatal: '<branch>' is already used by worktree at ...` | Leftover state from previous run. | `cd ~/projects/code-valley && git worktree remove --force .worktrees/<task-id> && git branch -D agent/anubis/<task-id>` |
| `worktree creation failed: fatal: invalid reference: main` | Project's `default_branch` is not `main` (e.g. `master` or `develop`). | `UPDATE projects SET default_branch='master' WHERE slug='...';` |
| Agent gets the worktree but `git push` fails with 403 | `GITHUB_TOKEN` lacks `Contents: write` or `gh auth setup-git` wasn't run on host. | Rotate PAT, re-run `gh auth setup-git`, restart daemon. |
| `git: command not found` in dispatch log | Daemon image wasn't rebuilt after the Dockerfile change. | `docker compose up -d --build openclaw-daemon` |
| Schema migration fails on start | Pre-existing DB has columns from a manual ALTER. | Check `sqlite3 /data/specs.db ".schema projects"` and reconcile manually. |
| No `worktree …` log line at all | Daemon image wasn't rebuilt OR the dispatcher is going through an old code path. | Verify `dist/harness/worktree.js` exists in the container (Test 1). |

## Follow-ups (not blocking v0 test)

Ordered by likely-next-need:

1. **Dashboard Projects form** for `github_repo` + `default_branch`. Currently
   SQL-only registration. Small UI patch on the Projects page +
   `POST /api/projects` payload.
2. **`/api/projects` response** exposes the new fields, so
   `leaderClient.readProject` on followers can return them and follower
   machines can also create worktrees against their local clones.
3. **Auto-cleanup on DONE.** Hook inside `TasksRepo.writeFile` after
   `recomputePhase`: compare old/new phase, on transition into DONE
   call `git worktree remove` and `git branch -d` (skip if dirty).
   Behavior decision: refuse cleanup on uncommitted changes (preserve
   work) vs. auto-WIP-commit (preserve cleanliness).
4. **GC sweep** for orphaned worktrees. Leader-only cron walking
   `git worktree list` for each project, removing entries older than N
   days where the corresponding task is in DONE/abandoned state.
5. **`POST /api/projects` write-side support for the new fields** —
   prereq for (1).
6. **Telemetry surface** — a `/api/tasks/:id/worktree` GET that returns
   `{path, branch, dirty, ahead, behind}` for the dashboard's task
   detail page.
7. **Stage B promotion** (the 5 typed RPCs from `design.md`) only if
   v0.5 hits a hard wall — e.g. an agent that pushes secrets despite
   the identity.md rule, motivating a server-enforced path allowlist.

## Validation criteria for "Stage 0.5 ships"

The bar before declaring this stage done:

- [ ] Test 1 passes — schema, binary, mount all wired.
- [ ] Test 2 passes — first dispatch creates a worktree the host
      can see via `git worktree list`.
- [ ] Test 3 passes — Anubis successfully opens a PR end-to-end
      against `code-valley` (or chosen test repo).
- [ ] Test 4 passes — re-dispatch reuses the worktree.
- [ ] Test 5 passes — legacy non-github project still dispatches
      normally.
- [ ] No secrets land in any committed file or the PR description.
- [ ] No commits to `main` or any non-agent branch.

Once those check, this stage is acceptance-tested and we can either
ship as-is or layer on follow-ups (1) and (3) for usability.
