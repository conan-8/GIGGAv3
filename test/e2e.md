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

- GIGGA installed (`install.sh`), `/gigga-setup` run (tiers mapped).
- Working directory: a standalone git checkout of `test/fixtures/`
  (opencode resolves cwd to the git root — a nested dir would change scope).
- For D: `maxParallel: 1` in `~/.config/opencode/gigga/gigga.config.json`.

## Scenarios

### A. Simple question → fasttrack
Send to gigga: `What does parseConfig in lib/parser.js do?`
Expect: straight answer; a `gigga-fasttrack` task (visible in
`~/.config/opencode/gigga/events.log`); NO `gigga-recon` task, no todo list,
no questions.

### B. Multi-step task → full pipeline
Send: `Add input validation to both parsers: parseConfig in lib/parser.js and
parseArgs in src/argv-parser.ts. Reject empty or malformed input with clear
error messages, for every entry point.`
Expect: ≤2 question rounds (bell + toast when a question is pending);
a todo plan; ≥1 numbered `gigga-worker-*` tasks; `state.json` shows
`phase: "executing"` with numbered worker entries going working→done;
`gigga-checker` task returns `VERDICT: PASS`; fixture files actually changed.

### C. Sabotage → FAIL → retry fixes
Workers are made to skip the last item of their brief (the automated driver
injects a SABOTAGE line into the worker agent files). Request asks for two
things (validation + JSDoc docs). Expect: checker `VERDICT: FAIL` with a gap
list naming the missing piece; after `/gigga-retry` (or answering the retry
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

## Evidence

Results land in `test/results/<date>.md` with real captured output.
