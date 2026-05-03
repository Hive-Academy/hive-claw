---
name: security-review
description: Complete a security review of the pending changes on the current branch. Walks OWASP Top 10, secret handling, auth paths, and the persona-privacy invariant. Cites file_path:line_number for every claim.
---

# Security Review Skill

Stub — full body pending. Referenced by `shared-specs/memory/agents/horus/harness.yaml`
in both chat and orchestration tiers. Loaded into the persona's system prompt by
the bot-bridge (chat tier) and materialized into the per-agent settings.json
(orchestration tier) so the dispatch worker's ptah subprocess sees it.
