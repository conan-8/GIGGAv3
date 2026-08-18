# GIGGA

An orchestrator agent system for [opencode](https://opencode.ai). GIGGA plans
your request, asks up to N rounds of clarifying questions, dispatches numbered
worker subagents in parallel (low/medium/high model tiers), and runs a
read-only sanity check before reporting back.

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/conan-8/GIGGAv3/main/install.sh | bash
```

> The GitHub owner is a constant (`OWNER`) at the top of `install.sh` — change
> it there and in the URL above if you fork.

Then:

1. Restart opencode.
2. Press **Tab** to switch to the `gigga` agent (next to Plan/Build).
3. First request → GIGGA walks you through `/gigga-setup` (pick tier models
   from your own providers, maxParallel, autoRetry, sound).

Uninstall: `bash uninstall.sh` (removes only GIGGA files, restores your
opencode.json backup).

<!-- TODO: animated GIF of the orchestrator flow -->
<!-- TODO: dashboard screenshot -->

## Contents

- [Features](#features)
- [The two UIs](#the-two-uis) (TUI + dashboard)
- [Configuration](#configuration) (reference table)
- [Troubleshooting](#troubleshooting) (bell, port, stale state)
- [Requirements](#requirements)

## Features

- **gigga** orchestrator primary agent — Tab-switchable; does the planning,
  not the coding.
- **Read-only recon** (`gigga-recon`) inspects your repo and asks clarifying
  questions (≤ `questionRounds` rounds — enforced by the plugin, which
  silently drops questions past the cap — then explicit assumptions).
- **Numbered workers** (`gigga-worker-low/medium/high`) run in parallel
  (≤ `maxParallel`); hard tasks may spawn sub-subagents (`subagent_depth: 2`).
- **Read-only checker** (`gigga-checker`) verifies the result against your
  original request; auto-retry (≤ 2) or ask, per config.
- **Fasttrack** for simple requests: automatic, `/gigga-fasttrack`, the
  dashboard's glowing button, or by answering a pending question with
  "fasttrack".
- **Pending-question signals**: terminal bell + TUI toast; dashboard red
  ring + beep. Phase toasts ("GIGGA: planning… / 3 workers running / checking…").
- **Per-project run state** under
  `~/.config/opencode/gigga/projects/<project>-<hash>/state.json` — multiple
  projects on one machine never collide. Interrupted runs (killed opencode)
  are marked `failed (interrupted)` on the next start.
- **`/gigga-status`** — phase, agent table, pending-question state for the
  current project.

## The two UIs

**1. opencode TUI** — `gigga` in the Tab agent cycle; bell + toast on pending
questions; commands `/gigga-setup`, `/gigga-fasttrack`, `/gigga-retry`,
`/gigga-status`. Worker views are natively reachable: `→`/`←` cycles child
(subagent) sessions, `↑` returns to the parent (`session_child_cycle` &
friends — already the defaults). Prefer other keys? Drop this in
`~/.config/opencode/tui.json` (not applied by GIGGA):

```json
{ "keybinds": { "session_child_cycle": "ctrl+right", "session_parent": "ctrl+up" } }
```

**2. GIGGA dashboard** — run `gigga-dashboard` (installed to
`~/.local/bin`, default port 4399, auto-falls back to a free port, opens your
browser). Sidebar with clickable worker boxes (#1, #2, … tier badges,
animated working borders with reduced-motion fallback), a progress stepper
(read repo → questions → plan → execute → check → done), red ring + beep
while a question is pending, glowing fasttrack button, and a config screen
(first run opens straight to it). It serves **one project** — the directory
you launch it from — and says so in the footer. Attaches to the running
opencode server when available; otherwise status-only mode from the state
file + opencode's on-disk session storage. Zero dependencies (node ≥ 20 or
bun). See [dashboard/README.md](dashboard/README.md).

## Configuration

`~/.config/opencode/gigga/gigga.config.json` — managed by `/gigga-setup`
(the `gigga-config` agent), the dashboard's config screen, or the shared CLI
(`node …/gigga/dashboard/lib/shared.mjs`). One implementation backs all
three. The installer never overwrites an existing config.

| key | type | default | meaning |
|---|---|---|---|
| `tiers.low/medium/high` | `provider/model` | anthropic haiku/sonnet/opus | worker models per tier (validated against your available providers) |
| `defaultTier` | low\|medium\|high | medium | tier used unless a task is escalated |
| `maxParallel` | int 1–20 | 5 | max concurrently working workers |
| `autoRetry` | bool | false | auto-retry checker gaps (≤ 2) without asking |
| `sound` | bool | true | bell + beep on pending questions |
| `questionRounds` | int 1–5 | 2 | clarifying-question rounds (plugin-enforced) |
| `configured` | bool | — | set to true by the wizard; gates first-run setup |

Saving a config also rewrites the `model:` lines in the worker agent files
and the orchestrator default (restart opencode sessions to apply).

## Troubleshooting

- **No bell on a pending question** — the plugin writes `\x07` to `/dev/tty`.
  macOS Terminal/iTerm2 and most Linux terminals ring by default; if silent:
  iTerm2 → Settings → Profiles → Terminal → "Silence bell" off (and "Bell
  notifications" optional). Windows Terminal enables the bell per profile
  (Advanced → Bell notification style); in Git Bash/WSL the hosting terminal
  decides. No external notifier is used by design. `sound: false` disables it.
- **Dashboard port in use** — it auto-falls back to the next free port and
  prints the URL; force one with `gigga-dashboard --port 4399`.
- **Stale boxes stuck "working"** — if opencode was killed mid-run, agents
  are marked `failed (interrupted)` after ~2 minutes on the next start (or
  dashboard reload). Old runs clear when the next request starts.
- **Wrong project in the dashboard** — it serves the directory it was
  launched from (shown in the footer); start it from your project root or
  set `GIGGA_PROJECT_DIR`.

## Requirements

- **opencode ≥ 1.18.18** (needs `subagent_depth`, agent `permission`
  frontmatter, the `plugins/` dir, `question` tool events).
- bash + curl; macOS, Linux, or Windows Git Bash/WSL. `node`, `bun`, or
  `python3` for the opencode.json merge; node ≥ 20 (or bun) for the
  dashboard.

See [SPEC.md](SPEC.md) for the full product spec and
[DEVIATIONS.md](DEVIATIONS.md) for opencode API realities discovered during
development.
