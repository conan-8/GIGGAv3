# GIGGA handoff — one page

## Architecture

```
user ── opencode (TUI or `opencode serve`)
        └─ GIGGA (primary agent, agents/GIGGA.md — all-caps, red)      ← state machine, never codes
           ├─ GIGGA-recon      read-only briefs + ≤N question rounds
           ├─ GIGGA-worker-low/medium/high              numbered executors
           │    └─ (optional sub-subagents, needs permission.task: allow)
           ├─ GIGGA-checker    read-only VERDICT/GAPS vs original request
           ├─ GIGGA-fasttrack  one-shot path for simple requests
           └─ GIGGA-config     scoped setup agent (drives the shared CLI)

plugin/GIGGA.ts  ← event bus → per-project state.json (atomic, locked),
                   bell/toast signals, phase toasts, question cap,
                   stale-run recovery, server.json discovery
dashboard/       ← zero-dep node server + vanilla UI; reads state.json,
                   opencode HTTP when up, opencode.db (SQLite) otherwise
lib/shared.mjs   ← THE config implementation (validate/apply/models/status/
                   wizard CLI) used by dashboard, config agent, tests
```

Run state: `~/.config/opencode/GIGGA/projects/<slug>-<hash10>/state.json`
(project dir keyed; plugin and dashboard compute the path identically —
parity unit test enforces it). Config:
`~/.config/opencode/GIGGA/GIGGA.config.json` (+ `configured` first-run gate,
`fasttrack.flag` escape hatch, `server.json` discovery).

## Where spec requirements live

| requirement | code |
|---|---|
| orchestration flow, phase discipline | `agents/GIGGA.md` (prompt state machine) |
| read-only enforcement | `permission: {edit: deny, bash: deny}` in recon/checker frontmatter |
| question cap | `plugin/GIGGA.ts` `tool.execute.before` (empties args at cap+1) |
| numbered workers, tiers, maxParallel | orchestrator prompt + plugin `task` event tracking |
| state machine + signaling | `plugin/GIGGA.ts` (`handleEvent`, `announcePhase`, `bell`, `toast`) |
| per-project state, recovery | `projectStatePath` (plugin + `lib/shared.mjs`), `recoverStaleState` |
| dashboard UI | `dashboard/public/*` (stepper, boxes, ring, fasttrack, config) |
| config wizard/validation | `dashboard/lib/shared.mjs` CLI + `agents/GIGGA-config.md` + dashboard screen |
| installer/uninstaller | `install.sh`, `uninstall.sh` (OWNER constant!) |
| status command | `commands/GIGGA-status.md` + `shared.mjs status` |

Known-limitation ledger: `DEVIATIONS.md` (25 verified opencode behaviors),
`test/COMPLIANCE.md` (requirement → evidence), `CHANGELOG.md`.

## Known limitations (opencode API realities)

- **No TUI red ring / rich widgets**: the TUI gets bell + toast only; the
  red ring lives in the dashboard. Workaround: dashboard or README-documented
  terminal bell settings.
- **Question tool from subagents is answerable but quirky headless**; the
  wizard's questions come from the GIGGA-config subagent session (TUI renders
  them fine; API drivers must answer via the global question endpoint).
- **Cap counts calls, not rounds** — under-asking possible, over-asking not.
- **Sub-subagents** require `permission: {task: allow}` on worker agents
  (verified on opencode 1.18.18); without it workers have no task tool.
- **Plugin instantiated per project root** — hence disk-state + lock design;
  never hold run state only in memory.

## Top 3 maintenance risks

1. **opencode plugin/API drift** (highest): event shapes (`question.asked`,
   task part updates), `tool.execute.before` semantics, permission patterns,
   and the SQLite schema are all version-pinned observations — a minor
   opencode release can break the plugin silently. Mitigation: keep
   DEVIATIONS.md current; run `bash test/e2e_driver.sh` after every opencode
   upgrade; pin a minimum version in README (≥ 1.18.18).
2. **LLM-prompt compliance**: the orchestrator/checker discipline (phases,
   no self-coding, retry caps) is prompt-enforced and model-dependent — a
   weaker default model degrades behavior without any code failing.
   Mitigation: the E2E suite is the regression net; keep tier defaults
   sensible.
3. **State-path coupling**: plugin (TS) and dashboard (mjs) duplicate the
   10-line path function by design (standalone plugin file); the parity unit
   test must run in CI forever, or state silently splits.

## Release checklist

1. `node --test dashboard/test/*.test.mjs` green.
2. `bash test/e2e_driver.sh` (A–F) green or documented.
3. `test/COMPLIANCE.md` rows green or escalated.
4. Update CHANGELOG, tag `vX.Y.Z`, push, GitHub release with install
   transcript.
