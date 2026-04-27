# Workspace seed templates

These files are copied to `${WORKSPACE_DIR}` (default `~/projects/`) on first
run if that directory is empty. They define the bot's enduring identity and
working conventions across every project.

After the first run they live on the host and you can edit them freely. The
repo's copies remain as a baseline — if you wipe `~/projects/` and re-run
`./setup.sh` you get the same starting persona on any machine.

| File | Purpose |
|---|---|
| `IDENTITY.md` | Name, vibe, signature emoji |
| `SOUL.md` | Core behavior rules (skip "Great question", have opinions, etc.) |
| `AGENTS.md` | How the agent should treat its workspace |
| `USER.md` | What the bot has learned about you |
| `TOOLS.md` | Local environment notes (devices, hosts, etc.) |
| `HEARTBEAT.md` | Global recurring tasks the bot should track |
