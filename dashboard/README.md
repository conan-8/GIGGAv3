# GIGGA dashboard

The local GIGGA web app. Run it with `gigga-dashboard` (installed by
install.sh into `~/.local/bin`) or directly:

```bash
node ~/.config/opencode/gigga/dashboard/server.mjs [--port 4399] [--no-open]
```

- Zero dependencies; needs node ≥ 20 (or bun). Starts in well under 2 s.
- Attaches to the running opencode server (URL discovered from
  `gigga/server.json`, written by the plugin) and degrades gracefully to
  status-only mode (state file + `opencode.db` SQLite) when it's down.
- UI: progress stepper, orchestrator + numbered worker boxes (click one to
  view that agent's live conversation), red ring + beep on pending
  questions, glowing fasttrack button, config screen.
- Env overrides for testing: `GIGGA_HOME` (opencode config dir),
  `GIGGA_DATA_DIR` (opencode data dir).

Layout:

```
dashboard/
├── server.mjs        # HTTP + SSE server (no deps)
├── lib/shared.mjs    # config validation, tier-model rewrite, model list, state merge
├── public/           # index.html, app.js, style.css (vanilla, no build step)
├── bin/gigga-dashboard
└── test/             # node --test unit tests
```

Tests: `node --test dashboard/test/*.test.mjs`
