---
name: allone
description: Use Ekko Studio's owner-only /allone room command to ask Codex, Claude, Cursor Grok, and Hermes for one shared planning answer with per-agent receipts.
metadata:
  keywords:
    - allone
    - four agent planning
    - group chat
---

# Allone in Ekko Studio

In an Ekko Studio group room, `/allone <question>` and `@allone <question>` use the same owner-only team path. Connected agents answer privately; one local agent posts a merged reply with a receipt for each contributor. The room may contain a different set of agents, so inspect the actual receipt names before claiming a four-agent result.

Use one bounded question when the owner asks the room's agents to discuss or plan together. Give the agents the relevant evidence and ask them to distinguish observed facts, reports, and unknowns. Ask the merge to preserve disagreements and identify skipped, failed, or timed-out contributors. One merged reply is not four public messages.

The command starts model turns. Do not send it without the owner's authorization for that round, and do not retry a missing contributor automatically. Agent statements are planning input, not proof of system access, code execution, deployment, or owner approval. A failed or absent receipt remains visible and does not count as agreement.

For a connection check, ask each agent what it directly observed about Ekko, the Toronto VM, Cloudflare, project workspaces, and peer messages, and what remains unknown. Keep private credentials and unrelated profile history out of the prompt. Report the saved room reply and every receipt before calling the round complete.
