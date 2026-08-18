# GIGGA dashboard (placeholder)

The local GIGGA dashboard web app is built in session 3.

Planned:
- Sidebar: orchestrator tab + one mini-box per numbered worker (click to view
  that agent's thinking/progress in the main window; working/done status).
- Overall progress bar: read repo → questions → plan → execute → check → done.
- Red ring around the whole UI + beep while a question is pending.
- Glowing fasttrack button.
- Config screen.

It will consume `~/.config/opencode/gigga/state.json` (written by
plugin/gigga.ts) and the opencode server SSE stream (`opencode serve`,
`GET /event`) via `@opencode-ai/sdk`.
