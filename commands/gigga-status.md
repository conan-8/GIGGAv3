---
description: GIGGA status — current phase, agent table, pending-question state for this project
agent: gigga-fasttrack
---

Print GIGGA's live status for THIS project (this exact prompt already
contains the state JSON below — do not re-run anything, just format it).

Formatting rules:
- Line 1: `phase: <phase>` and `pending question: <yes/no>`.
- If `originalRequest` is non-empty, quote it (first 100 chars).
- Then a table of `agents`: columns number/kind, tier, status, task
  (truncate to 60 chars), session id (or `-`).
- If `agents` is empty: "No GIGGA run in this project yet — Tab to gigga and
  make a request."
- No file edits, no follow-up questions.

State JSON:

!`node "$HOME/.config/opencode/gigga/dashboard/lib/shared.mjs" status "$PWD" 2>/dev/null || echo '{"agents":[],"phase":"idle","pendingQuestion":false}'`
