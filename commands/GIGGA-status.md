---
description: GIGGA status — current phase, agent table, pending-question state for this project
agent: GIGGA
---

Print GIGGA's live status for THIS project (this exact prompt already
contains the state JSON below — do not re-run anything, just format it).

Formatting rules:
- Line 1: `phase: <phase>` and `pending question: <yes/no>`.
- If `originalRequest` is non-empty, quote it (first 100 chars).
- Then a table of `agents`: columns number/kind, tier, status, task
  (truncate to 60 chars), session id (or `-`).
- If `agents` is empty: "No GIGGA run in this project yet — Tab to GIGGA and
  make a request."
- If `lastRun` is present, one line: `last run: <phase> · <duration mm:ss> ·
  <retries> retries` plus `failed (<failReason>)` when it failed.
- If `lessons` > 0, one line: `self-improvement: <lessons> lessons recorded`.
- No file edits, no follow-up questions.

State JSON:

!`node "$HOME/.config/opencode/GIGGA/dashboard/lib/shared.mjs" status "$PWD" 2>/dev/null || echo '{"agents":[],"phase":"idle","pendingQuestion":false}'`
