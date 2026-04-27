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
7. Install skills and agents using the **real** (free-tier) command surface:
   - **Skills** — `ptah skill install <source>` where `<source>` is a
     `<owner>/<name>` from the skills.sh registry. Use
     `ptah skill recommended` first to let Ptah auto-detect what fits, or
     `ptah skill search <query>` to explore.
   - **Agents** — `ptah agent apply <name>` writes a built-in agent
     template into `.ptah/agents/<name>.md`. Use `ptah agent list` to see
     what's already applied. (`ptah agent packs install <pack>` exists
     but is **Pro-gated** — avoid it on the free tier.)
   - **MCP servers** — Ptah does not expose a `plugin enable` command.
     MCP server definitions live as JSON files inside `.ptah/agents/mcp-*.json`
     and are picked up by the harness. For free-tier projects, write these
     by hand (or copy from another project) — examples: `mcp-discord.json`,
     `mcp-filesystem.json`. Reference upstream MCP servers via their
     `command` + `args` + `env` keys.
8. Drop the OpenClaw overlay on top so HEARTBEAT/persona/per-project skills
   work: `bin/openclaw-init-project.sh <name>`. The `--with-ptah` flag
   chains steps 1–2 + 8 in one shot; finish 3–7 manually or via a
   follow-up agent turn.

### Picking skills / agents — concrete values that work today

The skills.sh registry uses `<owner>/<name>` slugs. These ones are known to
exist (verified via `ptah skill search`):

| Project type           | Skills (`ptah skill install …`)                         | Agents (`ptah agent apply …`)                  | MCP servers (write `.ptah/agents/mcp-*.json`)      |
|------------------------|---------------------------------------------------------|-------------------------------------------------|----------------------------------------------------|
| Discord/social bot     | `steipete/clawdis`, `kostja94/marketing-skills`, `resciencelab/opc-skills`, `openclaw/skills` | `backend-developer`, `senior-tester`, `content-publisher` | `mcp-discord.json`, `mcp-filesystem.json`     |
| Angular frontend       | `openclaw/skills`                                       | `frontend-developer`, `ui-ux-designer`          | `mcp-filesystem.json`, `mcp-playwright.json`       |
| NestJS API             | `openclaw/skills`                                       | `backend-developer`, `software-architect`       | `mcp-filesystem.json`, `mcp-postgres.json`         |
| CLI tool / lib         | `openclaw/skills`                                       | `backend-developer`, `senior-tester`            | `mcp-filesystem.json`                              |

Always start with `ptah skill recommended` — it inspects `package.json`,
file extensions, and frameworks in the project to suggest skills the user
hasn't asked for. Show the recommendations to the user before installing.

### Pro-gated features — avoid on the free tier

These commands return `{"ptah_code":"internal_failure","message":"Pro
subscription required..."}` and should NOT be invoked unless the user has
explicitly purchased a Pro subscription:

- `ptah harness design-agents` (use `ptah agent apply` of built-in templates instead)
- `ptah agent packs install <pack>` (use `ptah agent apply <name>` instead)
- `ptah harness generate-document --kind prd|spec` (write `PLAN.md` directly)

Detect the gate by the `internal_failure` ptah_code with the "Pro
subscription required" message and switch to the free-tier alternative
without prompting the user — they already know.

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
