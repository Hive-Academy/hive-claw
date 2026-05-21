---
name: long-task-workflow
description: |
  Workflow protocol for long-running multi-step tool tasks in the chat tier.
  Prevents the 630-second session timeout and context overflow by splitting
  work into small committed batches with operator checkpoints between rounds.
  Mandatory for any task involving 4+ sequential tool calls to a slow or
  verbose external API (Canva, GitHub, Zernio, browser, etc.).
---

# long-task-workflow skill

## When to activate this workflow

Activate whenever a task involves **any** of:
- 4 or more sequential tool calls to an external service
- Tool responses larger than ~2 000 characters (design content, file trees, API payloads)
- A transaction-based API where uncommitted work can expire (Canva editing transactions, DB transactions)
- Any task where you are unsure whether you can finish in one turn

The chat tier has a hard **630-second (10.5-minute) session timeout**. A single turn that makes many slow API calls will be killed before it can reply — losing all uncommitted progress.

## The batch-checkpoint loop

Structure every long task as a sequence of short turns.

### Turn 1 — Plan only, no mutations

1. Read the current state (design, repo, config — whatever is being edited).
2. Enumerate every operation needed as a numbered list.
3. Group them into batches of **3–5 ops** each.
4. **Reply to the operator with the plan.** Do not start making changes yet.
5. Wait for the operator to say "go" (or any acknowledgement) before executing.

Example planning reply:
```
Plan — 4 batches across 14 operations:
• Batch 1/4: replace title, subtitle, and 2 section headers (4 ops)
• Batch 2/4: replace 4 body text elements (4 ops)
• Batch 3/4: reposition 3 wide captions to left/right edges (3 ops)
• Batch 4/4: update footer and call-to-action (3 ops)

Background music must be added manually in the Canva editor — MCP cannot add audio.
Reply to start Batch 1.
```

### Turn 2+ — Execute one batch per turn

For each batch:
1. Open a fresh transaction if the API requires one.
2. Execute **only the operations for this batch** — do not continue into the next batch.
3. Commit the transaction **before replying**.
4. Reply with a short progress update and stop.
5. Wait for the operator's next message before starting the next batch.

Example progress reply:
```
✅ Batch 1/4 done — replaced title ("Multi-Agent Fleet Demo"), subtitle,
and 2 section headers with fleet-themed copy. Transaction committed.
Reply to continue with Batch 2 (body text).
```

## Transaction management rules

- **Never leave a transaction open when you reply.** Commit or explicitly rollback before every reply.
- **Never assume a previous transaction survives a session pause.** If resuming after a timeout, always open a fresh transaction — the previous one has expired.
- After committing, verify success before announcing it. If the commit fails, note it and try a single-op fallback.

## Context hygiene rules

- After each batch turn, your context has grown by one large tool response. This is expected.
- If you notice you are on batch 3+ and the context feels heavy, shorten your replies to one line — the operator does not need prose, just confirmation.
- Never fetch the full design content again mid-task if you already have the element IDs from Turn 1.

## Resuming after a timeout

If you find yourself resuming a task that was interrupted:

1. State what was committed before the timeout: "Batches 1–2 were committed successfully."
2. State what was lost: "Batch 3 was started but the transaction was never committed — starting that batch fresh."
3. Open a new transaction and redo only the uncommitted batch.
4. Do not replay already-committed operations — verify state first with a read call if unsure.

## Canva-specific notes

The `canva__perform-editing-operations` tool has a strict schema:
- **Required**: `transaction_id`, `page_index` (1-based integer), `operations` (array)
- **Each `replace_text` op**: `{ "type": "replace_text", "element_id": "<id>", "text": "<new>" }`
- **Do NOT include** a top-level `pages` field — causes validation failure.
- **Do NOT include** a top-level `user_intent` field — causes validation failure.
- If a batch fails validation, retry with a single-operation call to isolate which element is broken, skip it, and commit the rest.
