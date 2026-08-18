# GIGGA spec

GIGGA is an orchestrator agent system for opencode. It installs as a plugin +
agent pack via a one-line curl installer.

- Primary agent `gigga` (orchestrator), Tab-switchable like opencode's Plan/Build agents.
- Flow: user prompt → orchestrator classifies:
  - Simple recon question or one-step task → route directly to fasttrack agent, answer, done.
  - Everything else → call recon agent (read-only): inspect repo + user request, then ask the user clarifying questions, MAX 2 ROUNDS of questions. If still ambiguous after 2 rounds, proceed with explicitly stated assumptions.
- While any question is pending to the user: signal it (terminal: bell character + toast; dashboard: red ring around the whole UI + beep sound). Cleared when the user answers.
- After answers: orchestrator writes a todolist/plan (use opencode's todo mechanism if present), decides subagents (minimum 1), parallel or sequential at orchestrator's discretion. Orchestrator itself does almost no implementation work.
- Subagents are numbered (worker 1, 2, 3…). Max parallel subagents from config, default 5.
- A worker with a hard task may spawn sub-subagents (subagent_depth 2).
- Model tiers: low / medium / high, mapped to models from the user's already-configured opencode providers during first-run setup (config agent or setup UI). The user picks the default tier; the orchestrator may escalate per-task difficulty.
- After all workers finish: checker agent (read-only) does a sanity check — is the user's original request sufficiently fulfilled? On failure: ask the user whether to retry, OR auto-retry if `autoRetry` was enabled during setup. Retry = orchestrator fixes only the gaps the checker found.
- Manual fasttrack: user can force fasttrack during question answering and via a glowing sidebar button in the dashboard and via /gigga-fasttrack.
- Sidebar UI (dashboard): orchestrator tab + one mini-box per numbered subagent; clicking a box shows that agent's thinking/progress in the main window like a tab; each box shows working (red/spinning border; plain color indicator acceptable) or done. Overall progress bar above the boxes: read repo → questions → plan → execute → check → done.
- Beep must work on macOS, Linux, and Windows.
- One-line install from GitHub (curl | bash). Works in both the opencode terminal TUI and the dashboard app.

## Session-2 refinements (verified mechanisms, opencode 1.18.18)

- Questions are asked with opencode's built-in `question` tool (options UI);
  the plugin detects `question.asked` bus events and clears on
  `question.replied`/`question.rejected`.
- Pending-question signal: terminal bell = `\x07` written to `/dev/tty` by
  the plugin (gated on config `sound`); toast = `POST /tui/show-toast` on
  the opencode server (plugin uses its `serverUrl`).
- Worker lifecycle: tracked from `message.part.updated` tool parts where
  `tool === "task"` — `state.input.subagent_type` identifies the gigga agent
  and tier, the completed `state.output` embeds the subagent session id.
- Fasttrack forcing: `/gigga-fasttrack` writes
  `~/.config/opencode/gigga/fasttrack.flag`; the orchestrator consumes and
  deletes it at PHASE 1.
- `state.json` (written atomically by the plugin, tmp+rename):
  `{ phase: idle|recon|questions|plan|executing|checking|done|failed,
     pendingQuestion, originalRequest, agents: [{id, kind, tier, task,
     status, sessionId, parentSessionId}], updatedAt }`.

## Verified against opencode 1.18.18 (2026-08-18)

- Custom agents: markdown in `~/.config/opencode/agents/`, frontmatter `description`, `mode` (primary|subagent|all), `model`, `permission` (per-key allow/ask/deny). Primary agents join the Tab cycle. ✔
- `opencode.json` supports `subagent_depth` (default 1; we set 2) and an `agent` map. ✔
- Commands: markdown in `~/.config/opencode/commands/`, frontmatter `description`, `agent`, `model`, `subtask`; body is the template. ✔
- Plugins: TypeScript in `~/.config/opencode/plugins/` (plural), `export const X: Plugin = async ({ client, directory, worktree, $, serverUrl }) => hooks`. ✔
- `opencode serve`: HTTP + SSE (`GET /event`), SDK `@opencode-ai/sdk`. ✔

See DEVIATIONS.md for details.
