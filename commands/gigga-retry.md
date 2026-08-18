---
description: GIGGA retry — fix only the gaps the checker reported, then re-check
agent: gigga
---

The last GIGGA check FAILED. Retry now: re-read the checker's gap list from
this session, dispatch workers to fix ONLY those gaps (do not redo the whole
plan), then run the gigga-checker again and report PASS/FAIL.

$ARGUMENTS
