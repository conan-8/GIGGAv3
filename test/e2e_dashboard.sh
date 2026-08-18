#!/usr/bin/env bash
# Scenario F setup: prepares a sandboxed GIGGA run (opencode serve + fixture)
# and prints the env needed to start the dashboard against it. The browser
# verification itself is driven separately (see test/e2e.md scenario F).
#
# Usage:  bash test/e2e_dashboard.sh setup   -> prints "SB <dir>"
#         bash test/e2e_dashboard.sh prompt <text>  -> sends a gigga prompt
#         bash test/e2e_dashboard.sh answer           -> answers pending question (first option)
#         bash test/e2e_dashboard.sh stop
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT="${GIGGA_DASH_OC_PORT:-4470}"
BASE="http://127.0.0.1:$PORT"

SB_FILE=/tmp/gigga-dash-e2e.sb

do_setup() {
  SB=$(mktemp -d /tmp/gigga-dash-e2e.XXXXXX)
  echo "$SB" > $SB_FILE
  H="$SB/home"; FX="$SB/fixture"
  mkdir -p "$H/.config" "$H/.local/share/opencode"
  GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
  cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json" 2>/dev/null || echo "WARN no auth"
  MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
  [ -n "$MODEL" ] || MODEL=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -1)
  for f in "$H"/.config/opencode/agents/gigga-worker-*.md; do
    sed -i -E "s|^model: .*# (<!-- set by gigga-config -->)|model: $MODEL   # \1|" "$f"
  done
  python3 - "$H/.config/opencode/gigga/gigga.config.json" "$MODEL" <<'PY'
import json, sys
p, model = sys.argv[1], sys.argv[2]
cfg = json.load(open(p)); cfg["tiers"] = {"low": model, "medium": model, "high": model}
json.dump(cfg, open(p, "w"), indent=2)
PY
  python3 - "$H/.config/opencode/opencode.json" <<'PY'
import json, sys
p = sys.argv[1]
cfg = {}
try: cfg = json.load(open(p))
except Exception: pass
cfg["permission"] = {
    "external_directory": {"*": "allow"},
    "read": {"*": "allow"},
    "edit": {"*": "allow"},
    "bash": {"*": "allow"},
    "question": "allow",
}
json.dump(cfg, open(p, "w"), indent=2)
PY
  cp -r "$REPO/test/fixtures/." "$FX/"
  git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.email=e2e@t -c user.name=e2e commit -qm init
  ( cd "$FX" && HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null & )
  for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
  : > "$SB/sse.log"
  curl -sN "$BASE/event" >> "$SB/sse.log" &
  SESS=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' \
    -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  echo "$SESS" > "$SB/session"
  echo "SB $SB"
  echo "HOME $H"
  echo "DATA $H/.local/share/opencode"
  echo "SESSION $SESS"
  echo "DASH_PORT default 4471 (pass --port to override)"
}

cmd="${1:-}"
case "$cmd" in
  setup) do_setup ;;
  prompt)
    SB=$(cat $SB_FILE); SESS=$(cat "$SB/session")
    curl -s -X POST "http://127.0.0.1:${GIGGA_DASH_OC_PORT:-4470}/session/$SESS/prompt_async" \
      -H 'content-type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"agent":"gigga","parts":[{"type":"text","text":sys.argv[1]}]}))' "$2")" \
      -o /dev/null -w "prompt: %{http_code}\n" ;;
  answer)
    SB=$(cat $SB_FILE)
    python3 - "$SB/sse.log" "http://127.0.0.1:${GIGGA_DASH_OC_PORT:-4470}" <<'PY'
import json, sys, urllib.request
sse, base = sys.argv[1], sys.argv[2]
replied, pending = set(), []
for line in open(sse):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    t, p = d.get("type"), d.get("properties", {})
    if t in ("question.replied", "question.rejected"): replied.add(p.get("requestID"))
    elif t == "question.asked": pending.append((p.get("id"), [o.get("label","") for q in p.get("questions",[]) for o in q.get("options",[])]))
for rid, labels in pending:
    if rid in replied: continue
    body = json.dumps({"answers": [[labels[0] if labels else "yes"]]}).encode()
    req = urllib.request.Request(f"{base}/question/{rid}/reply", data=body, headers={"content-type": "application/json"})
    print("answered", rid, "with", labels[0] if labels else "yes", urllib.request.urlopen(req).status)
    break
else:
    print("no pending question")
PY
    ;;
  stop)
    SB=$(cat $SB_FILE 2>/dev/null || echo "")
    bash "$REPO/test/stop_servers.sh" "${GIGGA_DASH_OC_PORT:-4470}" 4471 2>/dev/null
    [ -n "$SB" ] && rm -rf "$SB" ;;
  *) echo "usage: $0 setup|prompt <text>|answer|stop" >&2; exit 1 ;;
esac
