# DEVIATIONS.md — opencode API assumptions vs reality

Verified against **opencode 1.18.18** (docs at https://opencode.ai/docs/ + `@opencode-ai/plugin` type definitions via unpkg) on 2026-08-18.

| # | Assumption | Reality | What we do |
|---|------------|---------|------------|
| 1 | Plugin dir is `~/.config/opencode/plugin/` | Global plugin dir is `~/.config/opencode/plugins/` (**plural**). Project dir `.opencode/plugins/`. | Installer copies to `plugins/`. |
| 2 | Frontmatter `tools`/`permission` to make read-only agents | `tools` is **deprecated**; `permission` is the current mechanism. Values `allow`/`ask`/`deny`; keys match tool names (`edit`, `bash`, `read`, …). | Read-only agents use `permission: { edit: deny, bash: deny }`. `bash: deny` blocks mutating shell entirely (bash could write files), so recon/checker get no bash at all — strictly read-only, verified in acceptance gate 4. |
| 3 | Toast via a client method | `tui.toast.show` is an **event type** on the bus, not a plugin hook or documented client method. The `Hooks` type has no TUI hooks (`tui?: never`). | Session 1 plugin only logs events + writes state.json. Exact toast emit path (bus event publish vs TUI control API) to be resolved in session 2; candidate: TUI control endpoints (`GET /tui/control/next`, `POST /tui/control/response`). |
| 4 | Plugin context includes `directory` and shell helper | Confirmed: `{ client, project, directory, worktree, experimental_workspace, serverUrl, $ }` where `$` is Bun's shell. | Used as-is. |
| 5 | Hooks `event`, `tool.execute.before/after` exist | Confirmed. Full hook list in `@opencode-ai/plugin`: `dispose`, `event`, `config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before`, `tool.execute.after`, `shell.env`, `tool.definition`, plus `experimental.*` (chat.messages.transform, chat.system.transform, provider.small_model, session.compacting, compaction.autocontinue, text.complete). | We use `event` only in session 1. |
| 6 | `opencode serve` + SSE + `@opencode-ai/sdk` | Confirmed. Default port 4096, `GET /event` SSE starting with `server.connected`. SDK generated from the OpenAPI spec at `/doc`. | Dashboard (session 3) will use the SDK. |
| 7 | `subagent_depth` in opencode.json | Confirmed (default 1, we set 2). | Installer merges it. |
| 8 | Command frontmatter `description`, `agent`, `model`, `subtask` | Confirmed. `$ARGUMENTS`/`$1…`, `` !`cmd` `` and `@file` substitutions exist. | Used as-is. |
| 9 | Agent `mode: primary` joins Tab cycle | Confirmed by docs (primary agents are Tab-switchable next to build/plan). | `gigga` is `mode: primary`. |
| 10 | Agent model placeholder must be machine-rewritable | YAML frontmatter can't hold raw HTML comments as values. | Workers carry a valid default `model:` line with a trailing YAML comment containing the marker `<!-- set by gigga-config -->`; gigga-config finds lines matching `model: ... # <!-- set by gigga-config -->` and rewrites them. |
| 11 | `edit: deny` blocks only the edit tool | Verified empirically: with `permission: {edit: deny, bash: deny}`, a subagent's tool list shrinks to `read`, `grep`, `glob`, `webfetch`, `skill` — no write/edit/bash at all (the write tool is governed by the `edit` permission key). | `edit: deny` + `bash: deny` is sufficient read-only enforcement (acceptance gate 4, opencode 1.18.18). |
| 12 | (API testing note) `POST /session` takes `agent`, not `agentID`; `POST /session/:id/message` ignores `agentID` | A subagent-mode agent requested as session agent silently falls back to `build` with full permissions — misleading when testing read-only agents. | Tests must invoke recon/checker as real subagents (task tool / @-mention) or via a `mode: all` test agent. |

