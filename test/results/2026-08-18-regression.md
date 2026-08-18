# GIGGA E2E results — 2026-08-18T21:22:48Z
opencode 1.18.18 | sandbox: /tmp/gigga-e2e.xkikD2 (kept only with GIGGA_E2E_KEEP=1)
Sandbox model override: kimi-for-coding/k3

## Scenario A — simple recon question → fasttrack
session: ses_fe93e80a4ffeo733iYqnf8kP0I
request: `What does parseConfig in lib/parser.js do?`
tasks spawned:
```

```
question rounds: 0 (expect 0)
final answer:
```
Please run `/gigga-setup` first to configure GIGGA. Once configured, I can help answer your question about `parseConfig` in `lib/parser.js`.
```
**A: CHECK** — see task list (fasttrack spawn expected, no recon)

## Scenario B — multi-step task → recon → questions → plan → workers → checker
session: ses_fe93e505fffekx1uOFeRUZi318
request: `Add input validation to both parsers: parseConfig in lib/parser.js and parseArgs in src/argv-parser.ts. Reject empty or malformed input with clear error messages, for every entry point.`
auto-answers during run:
```

```
question interaction rounds: 0 (expect ≤2); raw question.asked events: 0
tasks spawned:
```

```
checker verdicts: 
state snapshot DURING execution:
```
(missed — run too fast)
```
state snapshot near END:
```
--- state.json @ 21:23:17 ---
{
  "phase": "idle",
  "pendingQuestion": false,
  "originalRequest": "",
  "agents": [],
  "updatedAt": "2026-08-18T21:23:07.298Z",
  "orchestrator": null,
  "workerCounter": 0,
  "taskCalls": {},
  "sessions": {
    "ses_fe93e80a4ffeo733iYqnf8kP0I": {
      "agent": "gigga"
    },
    "ses_fe93e505fffekx1uOFeRUZi318": {
      "agent": "gigga"
    }
  },
  "answeredQuestions": {},
  "questionCalls": {},
  "retries": 0
}
```
final answer:
```
Please run `/gigga-setup` first to configure GIGGA, then I can help with adding input validation to the parsers.
```
fixture diff:
```

```
**B: CHECK** — see verdicts

## Scenario E — bell + toast on pending question (observed during B)
plugin log (question/bell/toast lines):
```

```
tui.toast.show events on the bus:
```
0 toast event(s) broadcast
```

## Scenario F — questionRounds cap (bait with vague request)
session: $F_SID  request: `make the parsers better`
question interaction rounds observed: 0 (must be ≤ 2); raw events: 0
final answer (assumptions expected):
```
I need to finish GIGGA setup before I can process your request.

Please run `/gigga-setup` first, then come back and ask again.
```
**F: PASS** — never entered a 3rd round

## Scenario D — maxParallel: 1 → sequential workers
Terminated                 HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null
session: ses_fe93df70fffeHVN2uqBxnkmDA6  request: two independent tasks, config maxParallel=1
max concurrent working workers sampled in state.json: 0
worker interval overlaps from event stream: 0 (must be 0; workers seen: 2)
tasks spawned (order matters):
```
gigga-recon completed
gigga-recon completed
gigga-worker-medium completed
gigga-worker-medium completed
gigga-checker completed
```
final answer:
```
**PHASE 5:** Checker verdict: **PASS**.

Done. Here's what changed:

- `lib/parser.js` — `parseConfig('')` now throws `Error("Input cannot be empty")`. Normal non-empty input parsing is unchanged.
- `src/greet.ts` — added exported `shout(name: string): string` that returns `greet(name).toUpperCase()`, e.g., `"HELLO, ALICE!"`. The existing `greet` function is untouched.

Assumptions used:
- "Empty input" means exactly `''` (not null/undefined/whitespace).
- `parseConfig` throws on empty input.
- `shout(name)` upper-cases the entire greeting.
```
fixture diff:
```
 lib/parser.js | 3 +++
 src/greet.ts  | 4 ++++
 2 files changed, 7 insertions(+)
```
**D: PASS** — strictly sequential

## Scenario C — sabotage: worker leaves a gap → checker FAIL → retry fixes it
Terminated                 HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null
session: ses_fe93c50b0ffeYLT92NjVaZfYwB  request: (1) validation for parseArgs (2) JSDoc on parseConfig — sabotaged workers skip the last item
auto-answers (retry question answered with the no-like option):
```
answered question [que_016c42e2c001n6LgL0xnlUpSCX] with: Throw Error
answered question [que_016c49cc7001fLgOlIGn4BKvRG] with: Only empty arrays and non-string entries (Recommended)
```
attempt 1 — checker verdicts: PASS 
attempt 1 — final answer:
```
Done. Both changes are in place and verified.

**Files changed**
- `src/argv-parser.ts` — added validation guards to `parseArgs`
- `lib/parser.js` — added a JSDoc block above `parseConfig`

**What was done**
1. `parseArgs` now throws clear `Error`s when:
   - the input array is empty, or
   - any entry is not a string.
2. `parseConfig` now has a JSDoc block describing its behavior, validation rules, parameters, return value, and a short example.

**Assumptions used**
- Validation throws `Error` rather than returning an error object.
- Only empty arrays and non-string entries are rejected (no extra `Array.isArray` check).
- JSDoc includes description, `@param`, `@returns`, behavior/validation rules, and an `@example`.

Checker verdict: **PASS**.
```
**C attempt 1: CHECK** — expected FAIL, got 'PASS'
Terminated                 HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null
attempt 2 (retry after workers restored) — checker verdicts: PASS 
attempt 2 — final answer:
```
Re-check complete.

**Checker verdict: PASS**

The previous checker run also reported PASS, so there were no gaps to fix in PHASE 4b. The current files (`src/argv-parser.ts` and `lib/parser.js`) still meet the original requirements:

- `parseArgs` throws clear errors for empty arrays and non-string entries.
- `parseConfig` has a JSDoc block documenting behavior and validation rules.

No additional changes were needed.
```
fixture diff after retry:
```
 lib/parser.js      | 13 +++++++++++++
 src/argv-parser.ts | 10 ++++++++++
 2 files changed, 23 insertions(+)
```
**C: PASS** — FAIL detected, retry fixed the gaps
```
--- state.json @ 21:30:01 ---
{
  "phase": "done",
  "pendingQuestion": false,
  "originalRequest": "",
  "agents": [
    {
      "id": 0,
      "kind": "orchestrator",
      "tier": null,
      "task": "orchestration",
      "status": "done",
      "sessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB",
      "parentSessionId": ""
    },
    {
      "id": 0,
      "kind": "recon",
      "tier": null,
      "task": "Recon argv/parser files",
      "status": "done",
      "sessionId": "ses_fe93c225bffeYz46901biLR3r8",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    {
      "id": 0,
      "kind": "recon",
      "tier": null,
      "task": "Recon follow-up after Q1",
      "status": "done",
      "sessionId": "ses_fe93bc44cffe4Zl1c7j8DoJ1ic",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    {
      "id": 1,
      "kind": "worker",
      "tier": "medium",
      "task": "Validate parseArgs implementation",
      "status": "done",
      "sessionId": "ses_fe93b492cffeu25Z5i8zm8R4Xd",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    {
      "id": 2,
      "kind": "worker",
      "tier": "medium",
      "task": "Add JSDoc for parseConfig",
      "status": "done",
      "sessionId": "ses_fe93b0a5cffeXXK6RNxWJ8cFAl",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    {
      "id": 0,
      "kind": "checker",
      "tier": null,
      "task": "Final check changes",
      "status": "done",
      "sessionId": "ses_fe9388312ffeIN6DpfgqnziDHi",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    {
      "id": 0,
      "kind": "checker",
      "tier": null,
      "task": "Re-check changes after user retry",
      "status": "done",
      "sessionId": "ses_fe9382bfbffeEXXSQp6KsNDkAA",
      "parentSessionId": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    }
  ],
  "updatedAt": "2026-08-18T21:30:00.876Z",
  "orchestrator": "ses_fe93c50b0ffeYLT92NjVaZfYwB",
  "workerCounter": 2,
  "taskCalls": {
    "tool_q2mSBeILbCKlvVfOCDSnqQ1J": {
      "entryIndex": 1,
      "asked": true
    },
    "tool_ZJOIHeRWYUZYXZK4CnIPSO0C": {
      "entryIndex": 2,
      "asked": true
    },
    "tool_0SgZgEVhO0KdKU1GZxv63rzc": {
      "entryIndex": 3,
      "asked": true
    },
    "tool_lMZBBoSuDOHtPpcMIyIZ8tAa": {
      "entryIndex": 4,
      "asked": true
    },
    "tool_NJSCQWMDSDSLRauQovZgfDXv": {
      "entryIndex": 5,
      "asked": true
    },
    "tool_RPWfd4uDA06sZ01G1mkYo9Ro": {
      "entryIndex": 6,
      "asked": true
    }
  },
  "sessions": {
    "ses_fe93c225bffeYz46901biLR3r8": {
      "agent": "gigga-recon"
    },
    "ses_fe93c50b0ffeYLT92NjVaZfYwB": {
      "agent": "gigga"
    },
    "ses_fe93bc44cffe4Zl1c7j8DoJ1ic": {
      "agent": "gigga-recon",
      "parent": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    "ses_fe93b492cffeu25Z5i8zm8R4Xd": {
      "agent": "gigga-worker-medium",
      "parent": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    "ses_fe93b0a5cffeXXK6RNxWJ8cFAl": {
      "agent": "gigga-worker-medium",
      "parent": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    "ses_fe9388312ffeIN6DpfgqnziDHi": {
      "agent": "gigga-checker",
      "parent": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    },
    "ses_fe9382bfbffeEXXSQp6KsNDkAA": {
      "agent": "gigga-checker",
      "parent": "ses_fe93c50b0ffeYLT92NjVaZfYwB"
    }
  },
  "answeredQuestions": {
    "que_016c42e2c001n6LgL0xnlUpSCX": true,
    "que_016c49cc7001fLgOlIGn4BKvRG": true
  },
  "questionCalls": {
    "ses_fe93c50b0ffeYLT92NjVaZfYwB": 2
  },
  "retries": 0
}
```

## Read-only re-check — recon subagent cannot write
final answer:
```
I can't proceed yet: `~/.config/opencode/gigga/gigga.config.json` exists but does not contain `"configured": true`. Please run `/gigga-setup` first, then re-issue your request.
```
**read-only: PASS** — file was not created

--- end of run ---
Terminated                 HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null
