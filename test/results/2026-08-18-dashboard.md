# GIGGA dashboard E2E — scenario F results (2026-08-18)

Environment: opencode 1.18.18 (sandboxed HOME), node v22.23.1, dashboard
server from `dashboard/server.mjs` (zero deps), UI verified in a real browser
(ZCode in-app browser, DOM-snapshot evidence below; screenshots unavailable —
see notes).

## Setup

`bash test/e2e_dashboard.sh setup` → sandbox HOME + standalone git fixture +
`opencode serve` (port 4470) + dashboard (port 4471, `GIGGA_HOME` +
`GIGGA_DATA_DIR` pointed at the sandbox). Request sent to the gigga agent:
"Add input validation to both parsers …".

## Observed (real browser DOM evidence)

1. **Empty state first**: "No GIGGA session — Start opencode and press Tab to
   switch to the gigga agent." Sidebar already shows the stepper, FASTTRACK
   button, config link.
2. **Server discovery**: note read `opencode server: http://127.0.0.1:4470/`
   — learned from `~/.config/opencode/gigga/server.json`, which the plugin
   wrote on load from its `serverUrl`.
3. **Boxes appear as the run progresses**: ORCH (working) → RECON (done,
   "Recon parser validation task") → second RECON ("Recon apply answers") →
   `#1 MEDIUM Validate parseConfig parser` → `#2 MEDIUM Validate parseArgs
   parser` → CHECKER, each with status badges going working→done.
4. **Red ring while a question was pending**: with `state.json`
   `pendingQuestion: true`, `#red-ring`'s `hidden` attribute was removed
   (element visible, inset red border + pulse per CSS); after answering,
   `hidden` returned. (Beep is WebAudio unlocked on first user gesture —
   cannot be audibly verified by automation; code path fires on the same
   pendingQuestion transition as the ring.)
5. **Click-through (hard requirement)**: clicking worker #1's box switched
   the main window to `worker #1` with its full conversation — the
   orchestrator's task brief (USER), reasoning lines, tool calls (`read`,
   `bash`, `edit` — each `completed`), and the final "Worker 1 report"
   (ASSISTANT). Verified twice: once live, once after killing the opencode
   server.
6. **Fasttrack button**: click → button class `armed`, text
   `✓ FASTTRACK ARMED` (reverts after 6 s), and
   `~/.config/opencode/gigga/fasttrack.flag` created on disk.
7. **Graceful degrade**: killed `opencode serve` mid-attach → note switched
   to "opencode server unreachable — status-only mode (state file + disk)";
   UI kept rendering from state.json and worker #1's messages still loaded —
   via the SQLite fallback (`opencode.db`, `node:sqlite` read-only), 5
   messages returned.
8. **Question rounds caveat (known from session 2)**: this run asked 4
   question rounds — the prompt-only `questionRounds` cap remains advisory.

## Unit tests

`node --test dashboard/test/*.test.mjs` → 9 pass / 0 fail (config validation,
tier-model rewrite + idempotency, state merge, port fallback, invalid-config
rejection).

## Acceptance gates

1. Scenario F: PASS — all UI behaviors above logged with real DOM evidence.
2. Fresh-shell `gigga-dashboard` (from `~/.local/bin`, sandbox HOME): starts,
   serves the UI, prints URL; killing opencode degrades to status-only mode
   with a visible notice. PASS.
3. Invalid config POST → 400 with specific errors (unit + API test); valid
   save round-trips and rewrites the worker agent files' `model:` lines
   (`applyTierModels` test asserts marker lines + orchestrator model
   insertion + idempotency). PASS.
4. Install size: **64K**, dependency count: **0** (no node_modules).

## Notes / flakiness

- In-app-browser `screenshot()` timed out on this page (animated CSS) and the
  browser broker later threw `response id mismatch` on locator clicks; reads
  (snapshots, locator reads) kept working and `dom_cua` node clicks worked.
  Evidence above is DOM-level, not pixel screenshots.
- The dashboard frontend now skips no-op re-renders (a 3 s poll was rebuilding
  boxes and could race user clicks); static responses send
  `cache-control: no-store` so updates load immediately.
- `install.sh` writes the launcher to `~/.local/bin` (standard user bin dir,
  PATH note printed if missing) — it deliberately never edits shell rc files.
