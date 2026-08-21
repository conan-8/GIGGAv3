#!/usr/bin/env bash
#
# GIGGA installer — opencode orchestrator plugin + agent pack.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/<OWNER>/GIGGAv3/main/install.sh | bash
#
# Cross-platform: macOS, Linux, Windows Git Bash / WSL.
# Idempotent: safe to run twice; never overwrites GIGGA.config.json;
# backs up opencode.json before touching it.

set -eu

OWNER="conan-8"          # <-- GitHub owner; change if you fork
REPO="GIGGAv3"
BRANCH="main"

GIGGA_HOME="${GIGGA_HOME:-$HOME/.config/opencode}"
GIGGA_DIR="$GIGGA_HOME/GIGGA"

msg()  { printf '%s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------- checks ---
case "$(uname -s)" in
  Linux*|Darwin*) : ;;
  MINGW*|MSYS*|CYGWIN*) msg "Windows (Git Bash/MSYS) detected." ;;
  *) die "Unsupported OS: $(uname -s). Use macOS, Linux, or Windows Git Bash/WSL." ;;
esac

# Require a POSIX-ish bash; refuse exotic shells when sourced via sh.
if [ -z "${BASH_VERSION:-}" ] && [ -z "${ZSH_VERSION:-}" ]; then
  die "Run this script with bash: bash install.sh"
fi

command -v opencode >/dev/null 2>&1 || die "opencode not found.
Install it first:
  curl -fsSL https://opencode.ai/install | bash
Then re-run the GIGGA installer."

command -v curl >/dev/null 2>&1 || die "curl is required but not found."

# ------------------------------------------------------------- download ----
# GIGGA_SRC=<repo dir> skips the download (used for testing / local installs).
SRC="${GIGGA_SRC:-}"
TMPDIR_G=""
if [ -z "$SRC" ]; then
TMPDIR_G="$(mktemp -d "${TMPDIR:-/tmp}/GIGGA-install.XXXXXX")"
trap '[ -n "$TMPDIR_G" ] && rm -rf "$TMPDIR_G"' EXIT

TARBALL="https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/$BRANCH"
msg "Downloading $REPO ($BRANCH) from $OWNER..."
curl -fsSL "$TARBALL" -o "$TMPDIR_G/repo.tar.gz" || die "download failed:
  $TARBALL
Check that OWNER=\"$OWNER\" at the top of install.sh is correct."
mkdir -p "$TMPDIR_G/repo"
tar -xzf "$TMPDIR_G/repo.tar.gz" -C "$TMPDIR_G/repo" --strip-components=1

SRC="$TMPDIR_G/repo"
fi
[ -d "$SRC/agents" ] || die "Downloaded archive has no agents/ dir — repo layout changed?"

# --------------------------------------------------------------- install ---
# brand migration (v0.1.0): lowercase layout -> GIGGA layout; user config is
# never lost — moved only if the new location is empty
if [ -d "$GIGGA_HOME/gigga" ] && [ ! -f "$GIGGA_DIR/GIGGA.config.json" ]; then
  mkdir -p "$GIGGA_DIR"
  [ -f "$GIGGA_HOME/gigga/gigga.config.json" ] &&     cp "$GIGGA_HOME/gigga/gigga.config.json" "$GIGGA_DIR/GIGGA.config.json" &&     msg "Migrated existing config from gigga/ to GIGGA/ (original kept)"
fi
mkdir -p "$GIGGA_HOME/agents" "$GIGGA_HOME/commands" "$GIGGA_HOME/plugins" "$GIGGA_DIR"

cp "$SRC"/agents/*.md        "$GIGGA_HOME/agents/"
cp "$SRC"/commands/*.md      "$GIGGA_HOME/commands/"
cp "$SRC"/plugin/GIGGA.ts    "$GIGGA_HOME/plugins/"
cp "$SRC"/plugin/GIGGA-sidebar.tsx "$GIGGA_HOME/plugins/"
cp "$SRC"/GIGGA.config.default.json "$GIGGA_DIR/"

# dashboard (server + UI + launcher)
if [ -f "$SRC/dashboard/server.mjs" ]; then
  mkdir -p "$GIGGA_DIR/dashboard"
  cp -R "$SRC/dashboard/." "$GIGGA_DIR/dashboard/"
  chmod +x "$GIGGA_DIR/dashboard/bin/GIGGA-dashboard" 2>/dev/null || true
  # put GIGGA-dashboard on PATH via a standard user bin dir (no shell rc edits)
  BIN_DIR="$HOME/.local/bin"
  if mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
    cat > "$BIN_DIR/GIGGA-dashboard" <<'LAUNCHER'
#!/usr/bin/env bash
exec "${GIGGA_DASHBOARD_NODE:-node}" "$HOME/.config/opencode/GIGGA/dashboard/server.mjs" "$@"
LAUNCHER
    chmod +x "$BIN_DIR/GIGGA-dashboard"
    case ":$PATH:" in
      *":$BIN_DIR:"*) msg "      GIGGA-dashboard command installed (already on PATH)" ;;
      *) msg "NOTE: $BIN_DIR is not on your PATH — add it to use the 'GIGGA-dashboard' command:"
         msg "      export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
  else
    msg "Could not write $BIN_DIR — start the dashboard with:"
    msg "  node $GIGGA_DIR/dashboard/server.mjs"
  fi
fi

# Config: never overwrite an existing one.
if [ -f "$GIGGA_DIR/GIGGA.config.json" ]; then
  msg "Keeping existing $GIGGA_DIR/GIGGA.config.json"
else
  cp "$SRC/GIGGA.config.default.json" "$GIGGA_DIR/GIGGA.config.json"
  msg "Created default $GIGGA_DIR/GIGGA.config.json"
fi

# Re-apply the user's saved model tiers to the freshly-copied agent files.
# install.sh copies the repo's DEFAULT model: lines over the installed
# agents, so without this an update/upgrade silently resets the worker tiers
# (and drops GIGGA.md's model line) until /GIGGA-setup is re-run. Apply only
# when a configured config exists — a fresh default config carries tier
# defaults the user may not even have available, and must not be injected.
if [ -f "$GIGGA_DIR/GIGGA.config.json" ] \
   && grep -qE '"configured"[[:space:]]*:[[:space:]]*true' "$GIGGA_DIR/GIGGA.config.json" 2>/dev/null; then
  APPLY_RUN=""
  if command -v node >/dev/null 2>&1; then
    APPLY_RUN="node"
  elif command -v bun >/dev/null 2>&1; then
    APPLY_RUN="bun"
  fi
  if [ -n "$APPLY_RUN" ] && [ -f "$GIGGA_DIR/dashboard/lib/shared.mjs" ]; then
    if "$APPLY_RUN" "$GIGGA_DIR/dashboard/lib/shared.mjs" apply "$GIGGA_HOME/agents" "$GIGGA_DIR/GIGGA.config.json" >/dev/null 2>&1; then
      msg "Re-applied your saved model tiers to the GIGGA agent files."
    else
      msg "NOTE: could not re-apply model tiers — run /GIGGA-setup to refresh them."
    fi
  else
    msg "NOTE: node/bun not found (or dashboard missing) — run /GIGGA-setup to re-apply your model tiers."
  fi
fi

# ------------------------------------------- merge subagent_depth: 2 -------
OPENCODE_JSON="$GIGGA_HOME/opencode.json"
merge_json() {
  # merge_json <file> — sets .subagent_depth=2, preserving other keys.
  # Prefers node, then bun, then python3. Prints merged JSON to stdout.
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      let raw = "";
      try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
      raw = raw.trim();
      if (raw.startsWith("//") || raw.startsWith("/*")) {
        console.error("jsonc");
        process.exit(3);
      }
      let cfg = {};
      try { cfg = raw ? JSON.parse(raw) : {}; } catch (e) {
        console.error("jsonc"); process.exit(3);
      }
      cfg.subagent_depth = 2;
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    ' "$1"
  elif command -v bun >/dev/null 2>&1; then
    bun -e '
      const fs = require("fs");
      let raw = "";
      try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
      raw = raw.trim();
      if (raw.startsWith("//") || raw.startsWith("/*")) { console.error("jsonc"); process.exit(3); }
      let cfg = {};
      try { cfg = raw ? JSON.parse(raw) : {}; } catch { console.error("jsonc"); process.exit(3); }
      cfg.subagent_depth = 2;
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    ' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PYEOF'
import json, sys
try:
    raw = open(sys.argv[1]).read().strip() if len(sys.argv) > 1 else ""
except FileNotFoundError:
    raw = ""
if raw.startswith("//") or raw.startswith("/*"):
    sys.exit(3)
cfg = json.loads(raw) if raw else {}
cfg["subagent_depth"] = 2
print(json.dumps(cfg, indent=2))
PYEOF
  else
    return 1
  fi
}

if [ -f "$OPENCODE_JSON" ] && grep -qE '^\s*(//|/\*)' "$OPENCODE_JSON" 2>/dev/null; then
  err "Your opencode.json appears to contain comments (JSONC)."
  err "Automatic merge skipped. Please set \"subagent_depth\": 2 in $OPENCODE_JSON yourself."
else
  if MERGED="$(merge_json "$OPENCODE_JSON")"; then
    if [ -f "$OPENCODE_JSON" ]; then
      cp "$OPENCODE_JSON" "$OPENCODE_JSON.backup.$(date +%Y%m%d%H%M%S)"
    fi
    printf '%s\n' "$MERGED" > "$OPENCODE_JSON"
    msg "Set subagent_depth=2 in $OPENCODE_JSON (backup kept)."
  else
    err "No node/bun/python3 found for JSON merge."
    err "Please set \"subagent_depth\": 2 in $OPENCODE_JSON yourself."
  fi
fi

# ------------------------------------------- merge tui.json plugin entry ---
# The sidebar widget is a TUI plugin (slot API) registered via the "plugin"
# array in tui.json. Existing entries (e.g. a tps plugin) are preserved.
TUI_JSON="$GIGGA_HOME/tui.json"
merge_tui_json() {
  # merge_tui_json <file> — ensures ./plugins/GIGGA-sidebar.tsx in .plugin[].
  # Prefers node, then bun, then python3. Prints merged JSON to stdout.
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      let raw = "";
      try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
      raw = raw.trim();
      if (raw.startsWith("//") || raw.startsWith("/*")) {
        console.error("jsonc");
        process.exit(3);
      }
      let cfg = {};
      try { cfg = raw ? JSON.parse(raw) : {}; } catch (e) {
        console.error("jsonc");
        process.exit(3);
      }
      cfg.$schema = cfg.$schema ?? "https://opencode.ai/tui.json";
      const entry = "./plugins/GIGGA-sidebar.tsx";
      cfg.plugin = Array.isArray(cfg.plugin) ? cfg.plugin : [];
      if (!cfg.plugin.includes(entry)) cfg.plugin.push(entry);
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    ' "$1"
  elif command -v bun >/dev/null 2>&1; then
    bun -e '
      const fs = require("fs");
      let raw = "";
      try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
      raw = raw.trim();
      if (raw.startsWith("//") || raw.startsWith("/*")) { console.error("jsonc"); process.exit(3); }
      let cfg = {};
      try { cfg = raw ? JSON.parse(raw) : {}; } catch { console.error("jsonc"); process.exit(3); }
      cfg.$schema = cfg.$schema ?? "https://opencode.ai/tui.json";
      const entry = "./plugins/GIGGA-sidebar.tsx";
      cfg.plugin = Array.isArray(cfg.plugin) ? cfg.plugin : [];
      if (!cfg.plugin.includes(entry)) cfg.plugin.push(entry);
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    ' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PYEOF'
import json, sys
try:
    raw = open(sys.argv[1]).read().strip() if len(sys.argv) > 1 else ""
except FileNotFoundError:
    raw = ""
if raw.startswith("//") or raw.startswith("/*"):
    sys.exit(3)
cfg = json.loads(raw) if raw else {}
cfg.setdefault("$schema", "https://opencode.ai/tui.json")
entry = "./plugins/GIGGA-sidebar.tsx"
plugins = cfg.get("plugin")
if not isinstance(plugins, list):
    plugins = []
if entry not in plugins:
    plugins.append(entry)
cfg["plugin"] = plugins
print(json.dumps(cfg, indent=2))
PYEOF
  else
    return 1
  fi
}

if [ -f "$TUI_JSON" ] && grep -qE '^\s*(//|/\*)' "$TUI_JSON" 2>/dev/null; then
  err "Your tui.json appears to contain comments (JSONC)."
  err "Automatic merge skipped. Please add \"./plugins/GIGGA-sidebar.tsx\" to its \"plugin\" array yourself."
else
  if MERGED="$(merge_tui_json "$TUI_JSON")"; then
    if [ -f "$TUI_JSON" ]; then
      cp "$TUI_JSON" "$TUI_JSON.backup.$(date +%Y%m%d%H%M%S)"
    fi
    printf '%s\n' "$MERGED" > "$TUI_JSON"
    msg "Registered plugins/GIGGA-sidebar.tsx in tui.json (backup kept)."
  else
    err "No node/bun/python3 found for JSON merge."
    err "Please add \"./plugins/GIGGA-sidebar.tsx\" to the \"plugin\" array in $TUI_JSON yourself."
  fi
fi

# ------------------------------------------------------------- next steps --
AGENT_COUNT=$(ls "$GIGGA_HOME/agents"/GIGGA*.md 2>/dev/null | wc -l | tr -d ' ')
CMD_COUNT=$(ls "$GIGGA_HOME/commands"/GIGGA-*.md 2>/dev/null | wc -l | tr -d ' ')
msg ""
msg "GIGGA installed into $GIGGA_HOME:"
msg "  agents/    ($AGENT_COUNT agents)   commands/ ($CMD_COUNT commands)   plugins/GIGGA.ts"
msg "  plugins/GIGGA-sidebar.tsx (TUI sidebar widget, registered in tui.json)"
msg "  GIGGA/GIGGA.config.json"
msg ""
msg "Next steps:"
msg "  1. Restart opencode."
msg "  2. Press Tab to switch to the GIGGA agent."
msg "  3. Run /GIGGA-setup to map your model tiers."
msg ""
msg "Uninstall anytime: bash uninstall.sh (or re-download it from the repo)."
