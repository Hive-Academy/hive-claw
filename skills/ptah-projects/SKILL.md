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

## Scaffold a new project (wizard flow)

The wizard is multi-step. Each step is a separate CLI call so you can show
progress and let the user redirect:

1. **`ptah new-project select-type`** — fetches the discovery questions for
   project archetypes.
2. Present the questions to the user (use `AskUserQuestion`-style structured
   choices, not bullet lists).
3. Write the answers to a JSON file, then **`ptah new-project submit-answers
   --file answers.json`**.
4. **`ptah new-project get-plan`** — load the generated plan. Show it to the
   user and ask for approval before executing.
5. On approval: **`ptah new-project approve-plan`** to persist.
6. Drop the OpenClaw overlay on top so HEARTBEAT/persona work:
   `bin/openclaw-init-project.sh <name>` (or use `--with-ptah` to chain both).

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
