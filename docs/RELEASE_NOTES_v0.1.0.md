# GIGGA v0.1.0 release notes

GIGGA is an orchestrator agent system for [opencode](https://opencode.ai):
it plans your request, asks up to N rounds of clarifying questions, dispatches
numbered worker subagents in parallel across low/medium/high model tiers,
and verifies the result with a read-only checker before reporting back.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/conan-8/GIGGAv3/main/install.sh | bash
```

Then restart opencode, press **Tab** to switch to `GIGGA`, and run
`/GIGGA-setup` on first use. Requires opencode ≥ 1.18.18, bash + curl;
node ≥ 20 (or bun) for the dashboard. Uninstall: `bash uninstall.sh`.

## Highlights

- **Orchestrator agent pack** — 8 agents: GIGGA (primary, Tab cycle),
  read-only recon/checker, one-shot fasttrack, scoped config agent, and
  three worker tiers.
- **The full loop** — classify → recon → ≤ questionRounds (plugin-enforced)
  → todo plan → numbered workers (maxParallel bound, parallel or sequential)
  → checker verdict (PASS / gap list) → ask-or-auto-retry (≤ 2), gap-only.
- **Signaling** — terminal bell + TUI toast in opencode; red ring + beep,
  live agent boxes, progress stepper, and a glowing fasttrack button in the
  local dashboard (`GIGGA-dashboard`, zero dependencies).
- **Per-project run state** with atomic writes and kill -9 recovery
  (interrupted runs are marked `failed (interrupted)`).
- **One shared config implementation** behind the setup wizard (agent +
  dashboard + CLI), with model validation against your real providers.
- **Tested**: 17 unit tests + scripted E2E with real transcripts
  (scenarios A–F, edge cases, 8-task soak) — see `test/COMPLIANCE.md`
  (42 rows: 41 green, 1 escalated).

## Known limitations

- Sub-subagent delegation (subagent_depth 2) is configured and prompted for,
  but opencode 1.18.18 does not expose the task tool to subagents —
  escalated in `test/COMPLIANCE.md` (row 12), tracked in `DEVIATIONS.md` #26.
- The question-round cap counts question-tool calls, not conversation
  rounds: it can under-ask, never over-ask.
- Terminal-bell behavior on macOS/Windows is documented in the README
  troubleshooting section (not lab-tested).

Full audit: `test/COMPLIANCE.md` · Architecture: `docs/HANDOFF.md` ·
Deviation ledger: `DEVIATIONS.md`
