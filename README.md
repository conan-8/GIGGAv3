# GIGGA

An orchestrator agent system for [opencode](https://opencode.ai). GIGGA plans
your request, asks up to 2 rounds of clarifying questions, dispatches numbered
worker subagents in parallel (with low/medium/high model tiers), and runs a
read-only sanity check before reporting back.

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/conan-8/GIGGAv3/main/install.sh | bash
```

> The GitHub owner is a constant (`OWNER`) at the top of `install.sh` — change
> it there and in the URL above if you fork.

<!-- TODO: animated GIF of the orchestrator flow -->

Then:
1. Restart opencode.
2. Press **Tab** to switch to the `gigga` agent (next to Plan/Build).
3. Run `/gigga-setup` to map your model tiers.

Uninstall: `bash uninstall.sh` (removes only GIGGA files, restores your
opencode.json backup).

## Features

- **gigga** orchestrator primary agent — Tab-switchable, does the planning,
  not the coding.
- **Read-only recon** (`gigga-recon`) inspects your repo and asks clarifying
  questions (max 2 rounds, then explicit assumptions).
- **Numbered workers** (`gigga-worker-low/medium/high`) run in parallel
  (default max 5); hard tasks may spawn sub-subagents (`subagent_depth: 2`).
- **Read-only checker** (`gigga-checker`) verifies the result against your
  original request; auto-retry or ask, per config.
- **Fasttrack** for simple requests: automatically, via `/gigga-fasttrack`,
  or the dashboard button.
- Pending questions ring a bell + toast so you don't sit waiting.

## The two UIs

1. **opencode TUI** — `gigga` appears in the Tab agent cycle; bell + toast on
   pending questions; `/gigga-setup`, `/gigga-fasttrack`, `/gigga-retry`
   commands.
2. **GIGGA dashboard** (local web app) — run `gigga-dashboard` (installed to
   `~/.local/bin`, default port 4399, auto-falls back to a free port and
   opens your browser). Sidebar with clickable worker boxes (#1, #2, … with
   tier badges and working/done states), an overall progress stepper (read
   repo → questions → plan → execute → check → done), red ring + beep while a
   question is pending, a glowing fasttrack button, and a config screen. It
   attaches to the running opencode server when available (the plugin
   publishes its URL) and otherwise runs status-only from the state file +
   opencode's on-disk session storage. Zero dependencies — needs `node` (or
   `bun`) ≥ 20. See [dashboard/README.md](dashboard/README.md).

<!-- TODO: dashboard screenshot -->

## Config

`~/.config/opencode/gigga/gigga.config.json` (default template
[`gigga.config.default.json`](gigga.config.default.json); the installer never
overwrites an existing config):

```json
{
  "tiers": { "low": "…", "medium": "…", "high": "…" },
  "defaultTier": "medium",
  "maxParallel": 5,
  "autoRetry": false,
  "sound": true,
  "questionRounds": 2
}
```

Managed by the `/gigga-setup` wizard (via the `gigga-config` agent), which
also writes your tier models into the worker agent files. For installer
testing, `GIGGA_HOME` overrides `~/.config/opencode`.

## Requirements

- **opencode ≥ 1.18.18** (version verified during development; needs
  `subagent_depth`, agent `permission` frontmatter, and the `plugins/` dir —
  all present in 1.18.x).
- bash + curl; macOS, Linux, or Windows Git Bash/WSL. `node`, `bun`, or
  `python3` for the opencode.json merge (falls back to instructions if none).

See [SPEC.md](SPEC.md) for the full product spec and
[DEVIATIONS.md](DEVIATIONS.md) for opencode API realities discovered during
development.
