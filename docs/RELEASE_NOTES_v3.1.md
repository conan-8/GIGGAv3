# GIGGA v3.1 release notes

GIGGA is an orchestrator agent system for [opencode](https://opencode.ai):
it plans your request, asks up to N rounds of clarifying questions, dispatches
numbered worker subagents in parallel across low/medium/high model tiers,
and verifies the result with a read-only checker before reporting back.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/conan-8/GIGGAv3/main/install.sh | bash
```

Then restart opencode, press **Tab** to switch to `GIGGA`, and run your first
request — GIGGA auto-configures all model tiers to the model you're using, so
there's no setup step. Requires opencode ≥ 1.18.18, bash + curl; node ≥ 20
(or bun) for the dashboard. Uninstall: `bash uninstall.sh`.

## What's new in v3.1

- **TUI sidebar** — a live sidebar view of each GIGGA run: a 6-step phase bar
  (red while running, green on completion), a ticking total-run clock,
  per-subagent status lights, braille spinners, and ✓/✗ finals with a flash
  on completion.
- **Session-scoped tree** — further prompts in a finished session *continue*
  the same run instead of starting fresh, with muted separator lines between
  prompt groups and both per-prompt and total session timers.
- **Multi-run support** — concurrent GIGGA sessions each keep their own state
  and sidebar; switching sessions switches the view, and finished runs are
  kept so you can switch back.
- **Self-improvement memory** — per-project run history (outcome, duration,
  retries, per-worker stats) plus a "lessons learned" file the orchestrator
  reads at session start; `/GIGGA-status` now reports your last run and
  lesson count.
- **Fasttrack racing bar** — an animated progress bar for one-shot/fasttrack
  runs, with an "armed" indicator; the full pipeline is now the default.
- **Smarter planning** — tasks decompose into small single-concern pieces
  (more, smaller workers) instead of a few large ones.
- **Zero-setup first run** — model tiers auto-configure from the model you
  used; config also accepts path-like local model ids.
- **Notifications** — in-TUI toasts plus desktop notifications and sound for
  questions, done, and failures.

## Fixed in v3.1

- Sidebar/toasts now work in plain TUI mode (previously failed silently).
- Plugin loads reliably under the opencode 1.18.18 loader.
- Updating no longer wipes your configured model tiers.
- One-shot requests are handled by GIGGA directly (fasttrack agent removed).

## Known limitations

- Sub-subagent delegation (subagent_depth 2) is configured and prompted for,
  but opencode 1.18.18 does not expose the task tool to subagents — tracked
  in `DEVIATIONS.md` #26.
- The question-round cap counts question-tool calls, not conversation rounds:
  it can under-ask, never over-ask.

Full audit: `test/COMPLIANCE.md` · Changelog: `CHANGELOG.md` ·
Architecture: `docs/HANDOFF.md` · Deviation ledger: `DEVIATIONS.md`