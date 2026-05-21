---
name: social-digest
description: |
  Instructs the agent on compiling periodic social-media digests from GitHub
  repository activity, release notes, and operator-provided source material.
  Emphasizes source citation, platform-native formatting, and operator
  approval before publishing.
---

# social-digest skill

## What a digest is

A social digest is a curated summary of recent technical activity designed
for publication on LinkedIn and Twitter/X. It bridges "what the team shipped"
with "what the community should know."

## Digest pipeline

1. **Collect** — Use the GitHub MCP tools (`list_releases`, `list_commits`) to
   gather recent activity from the repositories configured in the task
   description. If the operator pasted news URLs or RSS excerpts, read those
   too.
2. **Filter** — Keep only items with external significance: new features,
   breaking changes, security fixes, major dependency bumps, or community
   milestones. Skip internal refactors and typo fixes unless they have a
   story worth telling.
3. **Draft** — Produce two variants from the same source:
   - **LinkedIn version**: 2-3 short paragraphs, professional tone, explain
     *why* the change matters to users or the ecosystem. Include a call to
     action (star the repo, try the release, join the Discord).
   - **Twitter/X version**: 1-2 tweets max. Lead with the most impactful
     bullet. Thread only if necessary. Use hashtags sparingly
     (`#OpenSource`, `#DevTools`, project-specific tags).
4. **Cite** — Every claim must trace back to a specific GitHub release tag,
   commit SHA, or PR number. Format: `(repo@tag, PR #123)`.
5. **Review gate** — Present the draft to the operator and ask for approval.
   Do not invoke any publish tool until the operator explicitly says yes.

## Tone rules

- Be factual, not hype-y. "Shipped" is better than "Revolutionary."
- Avoid emojis in LinkedIn drafts; one or two max in Twitter drafts.
- Never invent features — if the release notes are vague, say "details are
  light" rather than speculate.
- When multiple repos are tracked, lead with the one that had the most
  user-facing impact this cycle.

## Output format

Return the digest as:

```
## Digest: <week range or date>

### LinkedIn draft
<paragraphs>

### Twitter/X draft
<tweets>

### Sources
- repo@tag — <one-line summary> — <URL>
```
