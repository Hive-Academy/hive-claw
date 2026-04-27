---
name: ptah-projects
description: 'Discover, scaffold, and orchestrate projects in the shared workspace using the Ptah CLI. TRIGGER when the user asks to "start a new project", "scaffold a project", "list my projects", "what projects do I have", "set up a repo", or anything involving GitHub auth/token configuration. Ptah CLI (`ptah`) is installed in the container; its config lives in ~/.ptah which is bind-mounted from the host so a single auth login covers both sides.'
---

# Ptah Projects Skill

The Ptah CLI (`ptah`) is your first-class tool for working with projects in the
shared workspace at `/home/agent/.openclaw/workspace` (mounted from the user's
host `WORKSPACE_DIR`, usually `~/projects`).

Ptah's config directory `~/.ptah` is **bind-mounted from the host**. That means:

- A single `ptah auth login github` (run on either side) authenticates both you
  and the user.
- Tokens, provider keys, and workspace registrations are shared.
- **Never** print, paste, or echo the contents of `~/.ptah/settings.json` —
  treat it as you would a `.env` file.

## When to use this skill

| User says…                                       | What to do                                |
|--------------------------------------------------|-------------------------------------------|
| "what projects do I have?" / "list projects"     | `ptah harness scan` → summarize           |
| "start a new project" / "scaffold X"             | New-project wizard (below)                |
| "set up GitHub auth" / "save my GitHub token"    | `ptah auth login github` or set-key       |
| "clone X and set it up"                          | `git clone` → `bin/openclaw-init-project.sh --with-ptah <name>` |
| "what models can I use?"                         | `ptah provider models list`               |

## Discover existing projects

```bash
ptah harness scan
```

Emits `workspace_context`, `available_agents`, `available_skills` as JSON. Parse
and summarize for the user — don't dump raw JSON unless asked.

## Scaffold a new project (full Ptah harness + wizard flow)

You are NOT scaffolding a bare folder — you are using `ptah-cli` to generate
a complete Ptah harness (subagents, skills, MCP servers) just like the
desktop app would, sharing the **same `~/.ptah/settings.json`** the user's
host already has set up.

Run these IN ORDER. Each is a separate CLI call so progress streams to the
user and they can redirect:

1. **`ptah harness init --dir .`** — creates `<project>/.ptah/` with the
   default subagent set, skills registry, and MCP server slots. Idempotent.
2. **`ptah new-project select-type`** — fetches discovery questions
   (project archetype, language, framework, deploy target).
3. Present the questions to the user via `AskUserQuestion` structured
   options (NOT bullet lists). One question per call when there are
   meaningful trade-offs.
4. Write the user's answers to `answers.json`, then
   **`ptah new-project submit-answers --file answers.json`**.
5. **`ptah new-project get-plan`** — load the generated plan. Show the user
   the human-readable summary (use `--human` if needed). Ask for approval
   before executing.
6. On approval: **`ptah new-project approve-plan`** to persist.
7. Install the skills, MCP servers, and agent packs that match the project's
   needs — call these explicitly so the user sees what's being added:
   - `ptah harness install-skill <name>` — e.g. `github`, `mcp-server`
   - `ptah plugin enable <mcp-server>` — e.g. `filesystem`, `discord`
   - `ptah agent packs install <pack>` — e.g. `senior-architect`,
     `technical-content-writer`, `frontend-developer`
8. Drop the OpenClaw overlay on top so HEARTBEAT/persona/per-project skills
   work: `bin/openclaw-init-project.sh <name>`. The `--with-ptah` flag
   chains steps 1–2 + 8 in one shot; finish 3–7 manually or via a
   follow-up agent turn.

### Picking skills / MCP servers / agent packs

Match to the project type — examples for common stacks:

| Project type           | Skills                       | MCP servers          | Agent packs                                        |
|------------------------|------------------------------|----------------------|----------------------------------------------------|
| Discord/social bot     | `github`, `mcp-server`       | `filesystem`, `discord` | `backend-developer`, `senior-tester`            |
| Angular SaaS frontend  | `github`, `angular-frontend-patterns` | `filesystem`, `playwright` | `frontend-developer`, `ui-ux-designer`   |
| NestJS API             | `github`, `ddd-architecture` | `filesystem`, `postgres` | `backend-developer`, `software-architect`      |
| Marketing/content      | `github`, `technical-content-writer` | `filesystem`, `web-search` | `technical-content-writer`              |
| CLI tool / lib         | `github`                     | `filesystem`         | `backend-developer`, `senior-tester`               |

If `ptah harness install-skill <x>` errors with "skill not found", run
`ptah skill install <x>` first (the registry-fetch variant) then re-try.

## GitHub auth

If the user asks to "save my GitHub token" or you hit a `gh`/`git` operation
that needs auth:

```bash
# Interactive (preferred — handles OAuth):
ptah auth login github

# Headless / token already in hand:
ptah provider set-key --provider github --key "$GITHUB_TOKEN"

# Verify:
ptah auth test --provider github
```

The `entrypoint.sh` will auto-seed `GITHUB_TOKEN` from `.env` on first boot if
present, but **only when no existing auth is detected** — never overwrites the
user's interactive login.

## Per-project `.openclaw/` overlay

After Ptah scaffolds the project, always run:

```bash
bin/openclaw-init-project.sh <project-name>
```

…to add the `.openclaw/` folder (persona override, HEARTBEAT, project skills).
This is **not** optional — it's how the user's per-project instructions reach
you on subsequent sessions.

## Output discipline

- `ptah` defaults to newline-delimited JSON. Use `--human` only when echoing
  to the user verbatim.
- Parse JSON output yourself; never paste raw `ptah` JSON back to the user.
- If `ptah` returns an error JSON, surface only the human-readable `message`
  field plus a one-line suggestion of what to try next.
