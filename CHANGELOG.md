# Changelog

## Unreleased

### Changed
- TUI sidebar: sessions are now titled as an **animated progress tree**
  (pure title text — the sidebar can't render widgets). The GIGGA row
  carries a 6-step phase bar with a pulsing current step plus one
  traffic-light dot per subagent (🟢 done · ❌ failed · 🟡 running · 🔴
  spawning); every subagent row shows a `├─`/`└─` connector, its status
  dot, a braille spinner, and — for workers — a time-budget bar (elapsed
  vs tier budget H 20m · M 10m · L 5m) with a ticking m:ss clock, freezing
  to `✓ m:ss` / `✗ m:ss` on completion. A finished run flashes 🎉 then
  settles to `✓ … done · mm:ss · N workers`. Driven by a 1-second sweep
  that PATCHes only changed rows in one batch; animation phases derive
  from wall-clock time so concurrent plugin instances can't flap titles.
  Replaces the old `GIGGA #N (tier) · task` checklist titles.
- State schema: agents gained optional `startedAt`/`endedAt`, runs gained
  optional `runStartedAt`/`doneAt`/`failReason` (old state files remain
  readable — missing fields just disable clocks/bars for those rows).

## v0.1.0 — 2026-08-19

First tagged release. Full spec implemented and audited
(`test/COMPLIANCE.md`).

### Added
- Orchestrator agent pack for opencode: `GIGGA` primary agent (Tab cycle),
  read-only `GIGGA-recon` / `GIGGA-checker`, one-shot `GIGGA-fasttrack`,
  scope-limited `GIGGA-config`, and `GIGGA-worker-low/medium/high`.
- Orchestration loop: classify → fasttrack or recon → ≤ N question rounds
  (plugin-enforced) → todo plan → numbered parallel/sequential workers →
  read-only check → ask/auto-retry (≤ 2) with gap-only fixes.
- Plugin: per-project state machine (`GIGGA/projects/<slug>-<hash>/state.json`,
  atomic writes, multi-instance safe), pending-question bell + TUI toast,
  phase toasts, question-round cap via `tool.execute.before`, stale-run
  recovery, server discovery (`server.json`).
- Dashboard: zero-dependency local web app — progress stepper, clickable
  agent boxes with live conversations, red ring + WebAudio beep, glowing
  fasttrack button, config screen; HTTP + SQLite disk fallback.
- Setup: conversational wizard (agent + dashboard + shared CLI, one
  implementation), `configured` first-run gate, cheat sheet.
- Commands: /GIGGA-setup, /GIGGA-fasttrack, /GIGGA-retry, /GIGGA-status.
- Installer: one-line curl|bash, idempotent, timestamped backups, config
  never overwritten; uninstaller restores opencode.json.
- Test suite: 17 unit tests + scripted E2E (scenarios A–F, edges, soak,
  compliance evidence) with real transcripts under test/results/.

### Changed
- Orchestrator agent renamed `GIGGA` → `GIGGA` (all-caps, red #f7768e in the
  Tab cycle); all internal references updated and re-verified.

### Known limitations
- The question-round cap counts question-tool calls, not interaction
  rounds — a model issuing many calls in one round can be silenced early
  (under-asking, never over-asking).
- Sub-subagent delegation is prepared for (`subagent_depth: 2`, worker
  prompts) but opencode 1.18.18 does not expose the task tool to subagents
  (COMPLIANCE row 12, DEVIATIONS #26) — escalated, not silently claimed.
- Bell on macOS/Windows terminals is documented (README troubleshooting),
  not lab-tested.
