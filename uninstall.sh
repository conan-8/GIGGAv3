#!/usr/bin/env bash
#
# GIGGA uninstaller — removes only what GIGGA installed, restores the
# newest opencode.json backup if present. Never touches anything else.

set -eu

GIGGA_HOME="${GIGGA_HOME:-$HOME/.config/opencode}"

msg() { printf '%s\n' "$*"; }

# Remove GIGGA's own directory (config included — this is an uninstall).
rm -rf "$GIGGA_HOME/gigga"

# Remove GIGGA agents/commands/plugin (only files GIGGA owns).
for f in gigga gigga-recon gigga-fasttrack gigga-checker gigga-config \
         gigga-worker-low gigga-worker-medium gigga-worker-high; do
  rm -f "$GIGGA_HOME/agents/$f.md"
done
for f in gigga-setup gigga-fasttrack gigga-retry; do
  rm -f "$GIGGA_HOME/commands/$f.md"
done
rm -f "$GIGGA_HOME/plugins/gigga.ts"

# Restore newest opencode.json backup; drop our subagent_depth key otherwise.
OPENCODE_JSON="$GIGGA_HOME/opencode.json"
LATEST_BACKUP="$(ls -1t "$OPENCODE_JSON".backup.* 2>/dev/null | head -n 1 || true)"
if [ -n "$LATEST_BACKUP" ]; then
  cp "$LATEST_BACKUP" "$OPENCODE_JSON"
  msg "Restored opencode.json from $LATEST_BACKUP"
elif [ -f "$OPENCODE_JSON" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      delete cfg.subagent_depth;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    } catch {}
  ' "$OPENCODE_JSON" && msg "Removed subagent_depth from opencode.json"
fi

msg "GIGGA uninstalled. Restart opencode to fully unload the plugin."
