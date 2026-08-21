# Changelog

## Unreleased

### Added
- Multiple concurrent GIGGA runs per project: state.json now holds one run
  per GIGGA session (`{ updatedAt, sessions, runs: { <orchSessionId>:
  RunState } }`) instead of a single run. Concurrent GIGGA sessions in the
  same project no longer overwrite each other's state, and the TUI sidebar
  shows each session its own run when you switch to it (backend routes every
  event to the run that owns its session; finished runs are kept 24 h / max
  20 so switching back still shows their final tree). Legacy single-run
  files are migrated on read; the dashboard shows the newest active run.
- TUI sidebar widget (`plugins/GIGGA-sidebar.tsx`, registered in
  `~/.config/opencode/tui.json` by the installer): a real sidebar view via
  opencode's TUI slot API showing the live run — 6-step phase bar (red
  while running, green once done, theme-independent) with a flashing
  current step and a ticking total-run clock to its right, one colored
  indicator light per subagent (green done · red failed · yellow running ·
  dim spawning), tree rows with braille spinners + ticking m:ss clocks,
  ✓/✗ finals, 🎉 flash on completion. Driven by a
  1s mtime-gated poll of the per-project state.json; hidden when no GIGGA
  run exists.
- Notifications that actually reach the TUI: question-pending / done /
  failed transitions raise an in-TUI toast plus opencode's cross-platform
  attention notification (desktop notification + named sound when the
  terminal is unfocused; tunable via `attention` in tui.json; sounds respect
  the GIGGA `sound` config flag).
- Self-improvement memory (per project): the plugin appends one objective
  record per finished run to `history.jsonl` in the project state dir
  (outcome, duration, retries, checker invocations, per-agent tier +
  duration + budget overrun), claimed by `state.recordedAt` so duplicate
  events never double-record. The orchestrator reads `lessons.md` + the last
  history lines at session start, and after each full-pipeline run reflects
  (PHASE 6): ≤3 one-line tagged lessons, each citing this run's trigger
  (checker gap, worker failure/retry, tier overrun, wasted question round);
  clean runs write nothing; the file caps at 20 lines and self-consolidates.
  The checker may attach a `LESSONS:` section to a FAIL verdict (planning
  mistakes only — it stays read-only; the orchestrator transcribes).
  `/GIGGA-status` now also shows the last-run record and lesson count;
  `shared.mjs` gains a `projectdir` CLI subcommand.

### Changed
- Sidebar widget is now **session-scoped**: it renders only in the tab
  viewing the run's session (orchestrator or one of its subagents) — other
  opencode tabs/sessions in the same project no longer show the run. A
  brand-new GIGGA session shows `░░░░░░ READING` until its first state
  update lands, instead of the previous run's leftover tree; and a new
  prompt in a finished run's session now resets to a fresh run (>3s guard
  against late final-message updates). The plugin records session
  `createdAt` to tell fresh sessions from old ones.
- Sidebar widget: two rows per subagent — row 1: indicator light, type
  label (`recon` / `worker #N` / `checker`), spinner, per-second ticking
  clock (the workers' time-budget bar was dropped — timer only); row 2:
  the concise task title. Worker `description`s are
  now mandated 2–5 words verb-first in the orchestrator prompt ("add
  finishing touches", not "procedurally adding finishing touches") — they
  are the sidebar titles. The ⚡ prefix is gone from the widget header.
- Fasttrack UX: one-shot/fasttrack runs show a racing-bar `FASTTRACK`
  animation (2-cell gap sweeping an 8-cell bar every tick); while the
  fasttrack flag is set, a `» FASTTRACK ARMED` line shows. Orchestrator
  prompt flipped to pipeline-by-default: fasttrack only for unambiguous
  single-step tasks; explicit user fasttrack stays a hard override.
- Planning: PHASE 3 now decomposes aggressively into small single-concern
  worker tasks (one file per worker per batch, typically 3+ workers, easy
  tasks on the low tier) instead of a few large ones.
- First run: GIGGA auto-configures all three model tiers to the model the
  prompt was sent with (the plugin records it via `chat.params` →
  `GIGGA/last-model.json`, skipping GIGGA's own sessions) and continues —
  no setup interrogation. `/GIGGA-setup` asks ONE batched confirm ("use
  <current model> for all tiers + defaults? / customize"); per-tier mapping
  only on request.
- `validateConfig` accepts path-like model ids (local providers key models
  by file path, e.g. `llamacpp//home/user/.cache/…/model.gguf`); missing
  provider / empty model id still rejected.

### Fixed
- TUI sidebar and toasts never appeared in plain TUI mode: the backend
  plugin PATCHed session titles / POSTed toasts to `serverUrl`, but the TUI
  hosts no HTTP server (DEVIATIONS #29), so every call failed with "Unable
  to connect" — retried every second, spamming events.log. The plugin now
  probes `serverUrl/global/health` once at load and skips the title sweep +
  HTTP toasts when unreachable (title tree still renders when attached to
  `opencode serve`); the slot widget above renders progress in-TUI instead.
- The `projectStatePath` parity test imported a deliberately private helper
  from plugin/GIGGA.ts (broken since the export-shape fix); it now compares
  normalized source text across all three copies (dashboard lib, backend
  plugin, TUI plugin).
- Plugin was silently failing to load in opencode (`failed to load plugin …
  "Plugin export is not a function"` / `"path" property must be of type
  string` in opencode.log): the 1.18.18 loader calls **every** module export
  as a plugin. `GIGGA.ts` now exports exactly one function (`GiggaPlugin`);
  all helpers, including `projectStatePath`, are module-private. Verified
  end-to-end: `opencode run` in a scratch project logs `plugin loaded`,
  writes `server.json`, zero load errors.

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
