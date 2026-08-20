# GIGGA spec compliance audit — v0.1.0 (2026-08-19)

One row per requirement from SPEC.md. Evidence key:
- `unit` = `node --test dashboard/test/*.test.mjs` (17/17 green)
- `S2/S3/S4` = scenario evidence in `test/results/2026-08-18*.md` (session runs)
- `soak` = `test/results/2026-08-19-soak.md`
- `deleg` = `test/results/2026-08-19-delegation.md`
- `clean` = clean-environment install transcript `test/results/2026-08-19-clean-install.md`
- `docs` = stated in README/SPEC/DEVIATIONS with rationale

| # | requirement (SPEC.md) | how verified | evidence | status |
|---|---|---|---|---|
| 1 | Primary agent `GIGGA` (all-caps, red #ff3333), Tab-switchable like Plan/Build | `mode: primary` in agents/GIGGA.md; server `/agent` lists `GIGGA \| primary \| color: #ff3333`; sessions run with agent=GIGGA (rename verified 2026-08-19; color updated to proper red 2026-08-19) | S2 outputs + rename verification (session ran under GIGGA) | ✅ |
| 2 | Simple question / one-step task → answered directly, no pipeline | scenario A: direct answer, no recon/workers spawned (originally via dedicated fasttrack agent; now GIGGA one-shots it itself) | S2/S4 regression A + post-change verification | ✅ |
| 3 | Everything else → read-only recon inspects repo + request | task streams show `GIGGA-recon` invoked before workers | S2 B, S4 regression B | ✅ |
| 4 | Clarifying questions, MAX 2 rounds; then explicit assumptions | recon invoked ≤2× per run; assumptions quoted in finals; plugin cap enforcement | S4 session4 E8 (questionRounds=1 held); S4 regression F PASS; cap log line in plugin events.log | ✅ |
| 5 | Pending question signaled in TUI: bell + toast | plugin writes `\x07` to /dev/tty + POSTs /tui/show-toast on question.asked | S2 E: plugin log lines + `tui.toast.show` bus events; S3 browser saw toast broadcast | ✅ |
| 6 | Pending question signaled in dashboard: red ring + beep | `#red-ring` un-hidden while pendingQuestion true; WebAudio 880 Hz/150 ms on transition, gesture-unlocked | S3 dashboard results: ring hidden-attr evidence live during question; beep code-path shared with ring transition (audible verification not automatable) | ✅ (beep code verified, not audibly) |
| 7 | Signal cleared when user answers | question.replied clears pendingQuestion; ring hidden again | S3: ring `hidden=""` after answer | ✅ |
| 8 | Orchestrator writes todo plan (native todo mechanism) | `todowrite` tool used; plugin mirrors phase=plan | S2 B tasks/state | ✅ |
| 9 | Subagents numbered (worker 1, 2, …) | state.json worker ids increment; boxes render #1/#2 | S2 B snapshots; S3 browser | ✅ |
| 10 | Max parallel from config, default 5 | 8-task soak with maxParallel=5: max concurrent ≤5 | soak (validation loop output) | ✅ |
| 11 | Parallel vs sequential at orchestrator's discretion | parallel: B (2 workers overlap OK with maxParallel 5); sequential: D (maxParallel 1, 0 overlaps from SSE intervals) | S2 B/D | ✅ |
| 12 | Worker with hard task may spawn sub-subagents (depth 2) | **ESCALATED** — opencode 1.18.18 subagents have NO task tool (worker answered the literal diagnostic `NO-TASK-TOOL`); adding `permission: {task: allow}` to worker frontmatter did not produce a task call either. `subagent_depth: 2` is set in config, but no spawn mechanism is exposed to subagents in this version. Wide-audit attempts show workers doing the work themselves (acceptable degradation) or the orchestrator batching more workers. Recommendation: keep the config + worker prompt support (it will light up when opencode exposes the tool), drop nothing, and re-test on the next opencode release; OR accept depth-2 as unsupported-for-now and amend the spec bullet. | delegation diagnostics (2026-08-19-delegation.md + direct NO-TASK-TOOL probe) | ⚠️ escalated |
| 13 | Tier models mapped from user's providers at first-run | guided wizard writes tiers + configured:true | S4 wizard transcript (PASS) | ✅ |
| 14 | User picks default tier; orchestrator escalates per difficulty | wizard asks default tier; tier mix observed (low+medium+high in one run) | S4 wizard; S2/S4 caller maps (4×low, 6×medium, 2×high in compliance run) | ✅ |
| 15 | Checker (read-only) sanity-check vs ORIGINAL request | `VERDICT: PASS/FAIL` + GAPS from GIGGA-checker task outputs | S2 B/C checker verdicts parsed from live task outputs | ✅ |
| 16 | On FAIL: ask user OR autoRetry; retry fixes only gaps | ask path: S2 C (retry question answered); auto path: S4 E3 | S2 C, S4 session4 E3 | ✅ |
| 17 | Auto-retry capped (≤2), no infinite loop | persistent-failure bait: 3 waves total (1+2) | S4 session4 E3: PASS | ✅ |
| 18 | Manual fasttrack: /GIGGA-fasttrack command | command file routes to GIGGA-fasttrack + writes flag | commands/GIGGA-fasttrack.md; flag file observed in S3 | ✅ |
| 19 | Manual fasttrack: dashboard glowing button | click → `✓ FASTTRACK ARMED` + flag file on disk | S3 browser evidence | ✅ |
| 20 | Manual fasttrack: mid-questions escape hatch ("fasttrack") | answering a pending question with literal "fasttrack" routes to fasttrack | S4 focus E1: PASS | ✅ |
| 21 | Sidebar: orchestrator box + one box per numbered subagent, clickable → that agent's message stream | click worker #1 box → main window shows its full conversation | S3 browser (twice: live + disk fallback) | ✅ |
| 22 | Box states: working (animated border, reduced-motion fallback) / done / failed | CSS conic-gradient + @media prefers-reduced-motion static; done/failed badges | dashboard style snapshot states in S3/S4 (badges in DOM: `MEDIUM done`) | ✅ |
| 23 | Overall progress stepper: read repo → questions → plan → execute → check → done | stepper elements + phaseIndex mapping; observed advancing | S3 browser; S2 B phase snapshots (recon→questions→executing→checking→done) | ✅ |
| 24 | Beep works macOS/Linux/Windows; where terminal swallows it, README documents the one setting | `\x07` to /dev/tty (POSIX) + WebAudio in dashboard; README troubleshooting covers iTerm2/Terminal/Windows Terminal | README troubleshooting section; Linux verified in S2 | ✅ (macOS/Windows documented, not lab-tested — see platform matrix) |
| 25 | One-line install from GitHub (curl \| bash) | REAL one-liner (`curl -fsSL https://raw.githubusercontent.com/conan-8/GIGGAv3/main/install.sh \| bash`) run in an isolated HOME with a scrubbed PATH against the pushed repo: rc=0, files landed, second run idempotent, opencode-missing failure mode rc=1, then the A–F suite from a fresh GitHub clone (B/F/D/C/read-only PASS; A answered correctly without spawning fasttrack — model discretion, spawn observed in prior runs) and `GIGGA-dashboard` smoke OK. | `test/results/2026-08-19-clean-install.md` (full transcript) | ✅ |
| 26 | Works in TUI and dashboard app | TUI flows via serve/API (same agent paths); dashboard verified in browser | S2–S4 | ✅ |
| 27 | Installer: idempotent, backups, never overwrites config | install twice → diff empty except timestamped backup; config preserved | S1 acceptance (rerun in clean transcript) | ✅ |
| 28 | Uninstaller removes only GIGGA files, restores opencode.json | uninstall in sandbox: agents/commands/plugins emptied, backup restored | S1 + S4 uninstall sanity | ✅ |
| 29 | Config schema (tiers/defaultTier/maxParallel/autoRetry/sound/questionRounds) | validateConfig enforces every field; invalid POST rejected 400 | unit tests; S3 config API test | ✅ |
| 30 | Read-only recon/checker: NO write capability | permission edit/bash deny; tool list shrinks to read/grep/glob/webfetch/skill; blocked-write demonstrated | S1 gate 4; S4 regression read-only PASS | ✅ |
| 31 | Per-project state (design correction) | distinct projects/<slug>-<hash>/state.json; dashboards read their own project | S4 focus E5: two files, dashboard A vs B | ✅ |
| 32 | Interrupted runs marked failed (interrupted) | kill -9 → recovery on next load | S4 focus E2: PASS; soak phase 2 | ✅ |
| 33 | questionRounds enforced end-to-end (plugin) | tool.execute.before empties question args at cap+1 | S4 session4 E8 + plugin log line | ✅ |
| 34 | First-run detection (missing config / unconfigured) | orchestrator refuses and points to /GIGGA-setup | S4 regression first attempt ("Please run /GIGGA-setup") | ✅ |
| 35 | Setup wizard: terminal + dashboard, same logic | GIGGA-config agent + dashboard both drive shared.mjs CLI | S4 wizard (agent) + S3 config screen; one implementation | ✅ |
| 36 | 5-line cheat sheet after setup | CHEAT_SHEET constant rendered by wizard + dashboard | S4 wizard final; dashboard config save handler | ✅ |
| 37 | Individual config edits ("change maxParallel to 8") | GIGGA-config agent prompt supports single-key edits via same CLI | agents/GIGGA-config.md (wizard + individual edits sections) | ✅ (prompt-level; exercised via CLI unit tests) |
| 38 | GIGGA-config scope-limited (never touches project files) | bash permission: deny-all wildcard FIRST, then CLI/models allows (last-match-wins) | agents/GIGGA-config.md frontmatter; S4 wizard ran with scoped bash successfully | ✅ |
| 39 | /GIGGA-status command | formats per-project state (phase, agents table, pending) | S4 session4 + focus status outputs | ✅ |
| 40 | Phase toasts | planning / N workers running (M slots free) / checking / done / failed | plugin announcePhase; toast events on bus in S4 runs | ✅ |
| 41 | Server.json discovery; dashboard degrades gracefully when server down | plugin writes server.json; dashboard health-checks, status-only mode with notice | S3: "status-only mode" note + disk-fallback messages | ✅ |
| 42 | Dashboard config screen validates models against available providers | /api/config lists models from server/CLI; validateConfig cross-checks | unit + S3 invalid-POST test | ✅ |

## Notes

- Rows 6 (audible beep) and 24 (bell on macOS/Windows): code paths verified;
  audible/platform behavior documented in README troubleshooting rather
  than lab-tested — see the platform matrix in the session report.
- Row 37: individual edits are agent-prompt-driven over the shared CLI; the
  CLI paths themselves are unit-tested.
- Row counts: 42 rows — 41 ✅, 1 ⚠️ escalated (row 12: sub-subagents —
  opencode 1.18.18 does not expose the task tool to subagents).
