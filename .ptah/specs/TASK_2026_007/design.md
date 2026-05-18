# TASK_2026_007 — Agent-as-developer workflow (clone → branch → edit → validate → PR)

**Type:** FEATURE (architectural extension)
**Status:** PROPOSAL — awaiting operator approval before implementation
**Created:** 2026-05-14
**Motivation:** TASK_2026_006 post-cutover diary entry — Anubis produced 6
real SEO files for `Hive-Academy/code-valley`, announced he would "push to
your repo," then went silent. Tool histogram: 29 `gh__get_file_contents`,
0 push-side tool calls. He had no path to commit.

## Problem statement

The agent today can READ any repo via `gh__get_file_contents` but his only
write surface is openclaw's local `write` tool — scoped to
`/home/agent/.openclaw/workspace/<agent>/` by the
`agents.defaults.tools.fs.workspaceOnly = true` invariant. Files written
there are invisible to the operator's actual project, never get reviewed,
never get tested. The mental model the operator wants:

> Anubis, work on `code-valley`: clone it, branch off `main`, make the SEO
> changes we discussed, run the tests, and open a PR. Stop when you need
> human review.

That requires four things the system doesn't have yet:

1. A way for the operator to declare "this is the project, here's its repo
   and where it lives on disk."
2. A way for the agent's writes to land in that project's working
   directory — without giving him write access to anything else.
3. A way for the agent to run git/test/lint commands against that working
   copy, scoped (he can commit, but only to a branch he opened, only to
   one repo).
4. A way to open a PR against the registered project's repo, with
   credentials the agent never directly handles.

## Non-goals

- **Not** giving the agent arbitrary shell access. He gets a fixed set of
  daemon-mediated tools, not `bash`.
- **Not** allowing pushes to any repo the agent names — only to the
  registered project's repo, enforced server-side.
- **Not** auto-merging. Every change ends as a PR awaiting human review.
- **Not** giving the agent the GitHub token directly — the daemon holds
  it and signs git operations on the agent's behalf.

## Proposed architecture

### 1. Extend the `projects` table

```sql
ALTER TABLE projects ADD COLUMN github_repo TEXT;     -- "owner/name"
ALTER TABLE projects ADD COLUMN default_branch TEXT;  -- e.g. "main"
ALTER TABLE projects ADD COLUMN workspace_path TEXT;  -- absolute path on host
```

The existing `workspace` column on `projects` already exists; this
formalizes it as the bare-clone path. `github_repo` is the canonical
"owner/name" the daemon will push to — independent of what URL the agent
might pass to a tool (defense against the agent tricking the daemon into
pushing somewhere else).

Schema migration: v6.

### 2. Register a project for development

Operator flow on the dashboard's Projects page:

1. "Add project" form: slug, name, GitHub repo (owner/name), default branch
   (default `main`), workspace path (default: choose).
2. Daemon does the bare clone *once* into the workspace path:
   `git clone --bare git@github.com:<github_repo>.git <workspace_path>/.git`.
3. Stored in `projects` row. SSE event `project.registered`.

The bare clone is the source of truth for the daemon. Per-task worktrees
are checked out from it.

### 3. Per-task worktree

When `create_task` runs and references a github_repo-backed project, the
daemon creates a worktree:

```
<openclaw-state>/<agent-id>/projects/<project-slug>/<task-id>/
  └── (working copy on branch `agent/<agent-id>/<task-id>` cut from default_branch)
```

This path lives **inside** the agent's openclaw workspace, which means:
- The openclaw `write` / `read` / `edit` tools (workspaceOnly) **just work** —
  the agent's normal file tools see the worktree as part of his sandbox.
- The persona-privacy invariant is preserved — the worktree is in the
  agent-private `<openclaw-state>/<agent-id>/...` tree, not in
  `local-memory/`.
- Two tasks on the same project don't conflict — each task gets its own
  worktree directory and its own branch.

The worktree is registered with the daemon: `worktree(taskId, projectSlug,
agentId, branchName, path, createdAt)`. SSE event `task.worktree.ready`.

### 4. Five new plugin tools (daemon-mediated)

All implemented in the plugin, all proxy to new daemon routes. None of
them give the agent shell access; each is a typed RPC that the daemon
implements with its own `child_process` calls, holding the GitHub token
itself.

| Tool | Purpose | Daemon route |
|---|---|---|
| `git_status(taskId)` | Show working-copy changes | `GET  /api/tasks/:id/git/status` |
| `commit_files(taskId, message, files[])` | Stage + commit specific paths | `POST /api/tasks/:id/git/commit` |
| `git_log(taskId, limit)` | Show recent commits on this branch | `GET  /api/tasks/:id/git/log` |
| `run_validation(taskId, command)` | Run one of a whitelist of test/build cmds | `POST /api/tasks/:id/validate` |
| `open_pull_request(taskId, title, body)` | Push branch + open PR via gh | `POST /api/tasks/:id/pr/open` |

Notes:
- `commit_files` takes an **explicit allowlist** of file paths the agent
  wants to commit. The daemon `git add` only those (no `git add -A`),
  rejects paths outside the worktree, rejects sensitive paths (`.env`,
  `*.pem`, etc. — same denylist as the dispatch worker).
- `run_validation` is a whitelist, not arbitrary commands. Per project the
  operator declares allowed commands (`npm test`, `npm run lint`, `npm run
  build`, `ng test`, etc.). The agent picks from the list; the daemon
  runs the literal command. Captured stdout/stderr + exit code go back as
  the tool result.
- `open_pull_request` pushes the branch (force-with-lease) and creates the
  PR via `gh pr create --repo <github_repo>`. The repo is locked to the
  registered `github_repo` field; an agent attempting to redirect the
  push to a different repo gets a 400.

### 5. Credentials

One PAT (or GitHub App installation token) per registered project, stored
encrypted in a new table:

```sql
CREATE TABLE project_credentials (
  project_slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  github_token_enc BLOB NOT NULL,   -- AES-GCM encrypted via OPENCLAW_JWT_SECRET-derived key
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
```

The token never leaves the daemon's address space. Plugin tools see only
{ok, stdout, stderr, branch, prUrl}. Token rotation is an operator-only
dashboard action.

If the operator declines to register a token, the project is
**read-only** — the agent can list/read files via the existing gh MCP, but
the five new tools all return `{"error":"no push credentials registered
for project <slug>"}`.

### 6. Task lifecycle integration

The existing task phases (CONTEXT → DESCRIPTION → PLAN → … → DONE) get a
new optional phase: **IMPLEMENT**. When a task is in IMPLEMENT and bound
to a github_repo project, its dashboard task-detail page shows:

- Worktree path (read-only display)
- Branch name
- Live "files changed" count (from `git_status`)
- "Run validation" buttons (one per registered command)
- "Open PR" button (delegates to the same daemon route the plugin tool
  uses — so the operator can drive the PR themselves if the agent won't)
- PR link once opened

### 7. Security model (layered)

- **Layer A — workspace containment.** The worktree path is a subdir of
  the agent's existing openclaw workspace. `workspaceOnly=true` already
  prevents the agent's file tools from escaping it.
- **Layer B — daemon-mediated git.** The agent has no shell; he can only
  invoke the five RPCs. The daemon implements each as a constrained
  `child_process` call.
- **Layer C — path validation.** Every file path the agent passes to
  `commit_files` is resolved + normalized + checked to be inside the
  worktree. `..`, symlinks pointing outside, and the sensitive-paths
  denylist are rejected.
- **Layer D — destination lock.** The push target is always the
  registered `github_repo`. The agent cannot redirect.
- **Layer E — branch isolation.** Each task gets `agent/<agent>/<task>`.
  The agent never has push access to `main` or other branches; daemon
  enforces the branch-name pattern.
- **Layer F — validation gate (optional, operator config).**
  `open_pull_request` can be gated on at least one successful
  `run_validation` call within the last N minutes. Off by default;
  recommended on for production projects.

### 8. Failure modes & recovery

- **Stale worktree** (task abandoned): daemon GC after N days of
  inactivity, with operator confirm dialog if the worktree has
  uncommitted changes.
- **Push fails** (branch protection, network): error captured in
  `dispatches` row, surfaced to agent + dashboard.
- **Test fails**: `run_validation` returns non-zero exit, agent can read
  the output and decide what to fix.
- **Token revoked**: daemon `gh` calls fail with 401; operator gets an
  alert; project flips to read-only.
- **Disk pressure**: each worktree is a checkout, not a fresh clone (the
  bare repo is shared). One project's 10 active tasks = 10 worktrees ≈ 10
  × repo size on disk. Operator can see worktree sizes on the project
  page.

## Smaller upfront alternative — "stage A"

If full Stage B is too big to bite off in one go, a Stage A that ships
80% of the operator value in maybe 20% of the work:

1. Add only `github_repo` + `workspace_path` to `projects` (skip the
   credentials table — just symlink the agent's `seo-geo-impl/` output
   into the host clone for the operator to manually commit).
2. Add a single plugin tool: `export_to_project(taskId)` which copies the
   agent's workspace files to a host-visible location and emits a clear
   markdown report telling the operator what to do next.
3. The operator does git/PR steps by hand — but the **handoff is
   explicit** instead of files-vanish-in-sandbox.

Stage A is a one-week implementation. Stage B is two to three weeks
(depending on how the credential storage + run_validation whitelist
shake out).

## Recommended decision points (for the operator to answer)

1. **Stage A first, or commit to Stage B?**
2. **Per-project PAT, or a single openclaw-control-bot GitHub App
   installation across all projects?** (App is more work to set up but
   cleaner: install once per repo, revocation is per-repo, scopes are
   constrained to "code/PRs only".)
3. **Validation whitelist — per-project config in the DB, or read from a
   `.openclaw/commands.json` checked into each repo's default branch?**
   (Second option is self-documenting for the agent — he can `read` the
   file to see what's allowed.)
4. **PR target branch — always `main`/`default_branch`, or operator can
   pick a base per-task?**
5. **What happens when the agent says "I'm done" but the worktree still
   has uncommitted files?** Auto-commit a "WIP" snapshot before
   declaring DONE, or refuse to declare DONE until the working tree is
   clean?

## Out of scope (Phase 2 candidates)

- Auto-rebase / merge-queue integration.
- Multi-agent collaboration on the same worktree (one branch per agent
  per task is the v1 boundary).
- Project import from arbitrary git remotes (only github.com supported in
  v1 — gitlab/bitbucket are dial-up-the-adapter follow-ups).
- Issue-linking / commit-message auto-population from task description
  (cute, but adds parsing burden — leave for v2).

## Acceptance (rough)

Stage B is acceptance-tested by:

1. Operator registers `code-valley` with its GitHub repo + a PAT.
2. Operator DMs Anubis: "implement the SEO/GEO plan in code-valley, the
   files you already wrote. Open a PR."
3. Anubis (via the new tools) commits the 6 files, runs `npm run build`
   via `run_validation` (succeeds), opens a PR.
4. Operator sees the PR link on the dashboard and in Discord, reviews,
   merges.
5. No files leaked anywhere they shouldn't; no commits to `main`; the
   PAT never appeared in any log or tool response.

## Next step

Operator confirms which stage (A or B), then a `team-leader` batch
decomposition translates this into `tasks.md` with the same Batch N shape
used by TASK_2026_006.
