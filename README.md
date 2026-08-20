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
2. Press **Tab** to switch to the `GIGGA` agent (next to Plan/Build).
3. First request → GIGGA auto-configures all model tiers to the model you're
   currently using (recorded per prompt by the plugin) and gets to work —
   no setup questions. `/GIGGA-setup` changes tiers/settings later (one
   batched confirm, defaults to your current model for all tiers).

Uninstall: `bash uninstall.sh` (removes only GIGGA files, restores your
opencode.json backup).


## Contents

- [Features](#features)
- [The two UIs](#the-two-uis) (TUI + dashboard)
- [Configuration](#configuration) (reference table)
- [Troubleshooting](#troubleshooting) (bell, port, stale state)
- [Requirements](#requirements)

## Features

- **GIGGA** orchestrator primary agent — Tab-switchable, all-caps and red in the agent picker; does the planning,
  not the coding.
- **One agent, one Tab slot**: `GIGGA` (all-caps, red) is the only primary
  agent — simple requests are fast-tracked by GIGGA itself in one shot.
- **Read-only recon** (`GIGGA-recon`) inspects your repo and asks clarifying
  questions (≤ `questionRounds` rounds — enforced by the plugin, which
  silently drops questions past the cap — then explicit assumptions).
- **Numbered workers** (`GIGGA-worker-low/medium/high`) run in parallel
  (≤ `maxParallel`); the plan decomposes aggressively into small,
  single-concern tasks (one file per worker per batch, easy tasks on the low
  tier); hard tasks may spawn sub-subagents (`subagent_depth: 2`).
- **Read-only checker** (`GIGGA-checker`) verifies the result against your
  original request; auto-retry (≤ 2) or ask, per config.
- **Fasttrack** (a mode of GIGGA, not a separate agent): automatic for
  simple requests, `/GIGGA-fasttrack`, the dashboard's glowing button, or by
  answering a pending question with "fasttrack".
- **Pending-question signals**: terminal bell + TUI toast; dashboard red
  ring + beep. Phase toasts ("GIGGA: planning… / 3 workers running / checking…").
- **Per-project run state** under
  `~/.config/opencode/GIGGA/projects/<project>-<hash>/state.json` — multiple
  projects on one machine never collide. Interrupted runs (killed opencode)
  are marked `failed (interrupted)` on the next start.
- **Self-improvement memory** (per project): the plugin appends one objective
  record per finished run to `history.jsonl` (duration, tier overruns,
  retries, checker rounds); after each full-pipeline run the orchestrator
  reflects (PHASE 6) and appends ≤3 evidence-cited one-line lessons to
  `lessons.md` (cap 20, self-consolidating) — and reads both back at session
  start, so planning/tiering improve over time. The checker contributes
  planning lessons via its verdict; it stays read-only.
- **`/GIGGA-status`** — phase, agent table, pending-question state, last-run
  record and lesson count for the current project.

## The two UIs

**1. opencode TUI** — `GIGGA` in the Tab agent cycle; bell + toast on pending
questions; commands `/GIGGA-setup`, `/GIGGA-fasttrack`, `/GIGGA-retry`,
`/GIGGA-status`. **The TUI sidebar (`ctrl+x b`) shows a live GIGGA progress
widget** — a real sidebar view rendered by `plugins/GIGGA-sidebar.tsx`
through opencode's TUI slot API (registered in `tui.json` by the installer):
a 6-step phase bar — red while running, green once done — with a flashing
current step and a ticking total-run clock to its right (a racing bar
during fasttrack one-shots, plus a `» FASTTRACK ARMED` line while the
fasttrack flag is set), one indicator light per subagent (green done ·
red failed · yellow running · dim spawning), and two rows per subagent —
the first with its status light, type label (`recon` / `worker #N` /
`checker`), braille spinner and a ticking per-second clock;
the second with its concise task title — freezing to `✓ m:ss` / `✗ m:ss`
when it lands. The widget is **session-scoped**: it renders only in the
tab viewing the GIGGA run's session — other tabs/sessions stay clean, and
a brand-new GIGGA session shows `░░░░░░ READING` until its first update
lands (a new prompt in a finished run's session starts a fresh run —
previous progress never carries over). A finished run flashes 🎉 and
settles to `✓ ▓▓▓▓▓▓ 12:30 done · 4 workers`. When
GIGGA asks a question, finishes, or fails, the widget raises an in-TUI
toast plus opencode's cross-platform attention notification (desktop
notification + named sound when the terminal is unfocused — tunable via
`attention` in `tui.json`). Worker views are also reachable inline:
`→`/`←` cycles child (subagent) sessions, `↑` returns to
the parent (`session_child_cycle` & friends — already the defaults). Prefer
other keys? Drop this in `~/.config/opencode/tui.json` (not applied by
GIGGA):

```json
{ "keybinds": { "session_child_cycle": "ctrl+right", "session_parent": "ctrl+up" } }
```

When the TUI is attached to `opencode serve` instead of running standalone,
the backend plugin additionally animates the sidebar's session **titles**
with the same tree (plain text + emoji dots — the only styling titles
support); in plain TUI mode those title PATCHes are skipped automatically.

**2. GIGGA dashboard** — run `GIGGA-dashboard` (installed to
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

`~/.config/opencode/GIGGA/GIGGA.config.json` — on the first GIGGA run it is
auto-written with all three tiers set to the model you sent the prompt with
(the plugin records the prompt-time model to `GIGGA/last-model.json` via
`chat.params`). Managed afterwards by `/GIGGA-setup`
(the `GIGGA-config` agent), the dashboard's config screen, or the shared CLI
(`node …/GIGGA/dashboard/lib/shared.mjs`). One implementation backs all
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
  prints the URL; force one with `GIGGA-dashboard --port 4399`.
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
