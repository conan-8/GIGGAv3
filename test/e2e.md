# GIGGA end-to-end test (session 2)

Two ways to run:

- **Automated** (what CI/development uses — drives the opencode server API):
  ```bash
  bash test/e2e_driver.sh > test/results/$(date +%Y-%m-%d).md
  ```
  The driver sandboxes everything (HOME override, standalone git copy of
  `test/fixtures/`, port-isolated `opencode serve`), auto-answers questions
  via `POST /question/{id}/reply`, and writes markdown evidence with real
  output. It needs a working opencode auth (`~/.local/share/opencode/auth.json`).
- **Manual** (in the opencode TUI): follow the scenarios below by hand.

## Preconditions

- GIGGA installed (`install.sh`), `/GIGGA-setup` run (tiers mapped).
- Working directory: a standalone git checkout of `test/fixtures/`
  (opencode resolves cwd to the git root — a nested dir would change scope).
- For D: `maxParallel: 1` in `~/.config/opencode/GIGGA/GIGGA.config.json`.

## Scenarios

### A. Simple question → fasttrack
Send to GIGGA: `What does parseConfig in lib/parser.js do?`
Expect: straight answer; a `GIGGA-fasttrack` task (visible in
`~/.config/opencode/GIGGA/events.log`); NO `GIGGA-recon` task, no todo list,
no questions.

### B. Multi-step task → full pipeline
Send: `Add input validation to both parsers: parseConfig in lib/parser.js and
parseArgs in src/argv-parser.ts. Reject empty or malformed input with clear
error messages, for every entry point.`
Expect: ≤2 question rounds (bell + toast when a question is pending);
a todo plan; ≥1 numbered `GIGGA-worker-*` tasks; `state.json` shows
`phase: "executing"` with numbered worker entries going working→done;
`GIGGA-checker` task returns `VERDICT: PASS`; fixture files actually changed.

### C. Sabotage → FAIL → retry fixes
Workers are made to skip the last item of their brief (the automated driver
injects a SABOTAGE line into the worker agent files). Request asks for two
things (validation + JSDoc docs). Expect: checker `VERDICT: FAIL` with a gap
list naming the missing piece; after `/GIGGA-retry` (or answering the retry
question with yes) with workers restored, only the gap is fixed and the
re-check PASSES.

### D. maxParallel: 1 → sequential
Two independent tasks. Expect: workers strictly one-at-a-time (the driver
samples `state.json` and reports the max concurrent `working` workers; must
be ≤1).

### E. Bell + toast during question-pending
Observed during B: terminal bell (`\x07` to `/dev/tty` — needs a terminal
attached; headless runs log the skip) and a `tui.toast.show` event broadcast
on the bus (visible in the SSE stream / dashboard).

### F. questionRounds cap (bait)
Vague request: `make the parsers better`, questions answered unhelpfully.
Expect: at most 2 `question.asked` rounds, then explicit assumptions.
(Known limitation, session 2: the cap is prompt-only and occasionally
exceeded — see test/results.)

### G. Dashboard live run (session 3)
1. `bash test/e2e_dashboard.sh setup` (sandboxed opencode + fixture; prints
   the sandbox paths and session id).
2. Start the dashboard against the sandbox:
   `GIGGA_HOME=<sandbox>/.config/opencode GIGGA_DATA_DIR=<sandbox>/.local/share/opencode \
    node dashboard/server.mjs --port 4471 --no-open`
3. Open http://127.0.0.1:4471/ in a browser → empty state, then
   `bash test/e2e_dashboard.sh prompt "<scenario B request>"`.
4. Expect: red ring while a question is pending (`#red-ring` un-hidden);
   numbered worker boxes (#1, #2) with tier badges and working→done status;
   stepper READ REPO → … → DONE advancing; clicking a box shows that agent's
   conversation in the main window.
5. `bash test/e2e_dashboard.sh answer` (repeat per question round).
6. Fasttrack button click → "✓ FASTTRACK ARMED" + `fasttrack.flag` on disk.
7. Kill the opencode server → dashboard shows "status-only mode" and worker
   messages still load via the SQLite disk fallback.

## Evidence

Results land in `test/results/<date>.md` with real captured output.
