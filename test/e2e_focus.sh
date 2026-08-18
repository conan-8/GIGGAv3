#!/usr/bin/env bash
# Focused session-4 rerun: edge 1, 2, 5, 7 + /gigga-status on a real run.
# (E3/E4/E6/E8 passed in the main session-4 run.)
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=4476
BASE="http://127.0.0.1:$PORT"
SB="$(mktemp -d /tmp/gigga-foc.XXXXXX)"
H="$SB/home"; SSE="$SB/sse.log"
md() { printf '%s\n' "$*"; }
code() { printf '```\n%s\n```\n' "$*"; }
pstate() {
  python3 -c '
import hashlib, os, sys
d, root = sys.argv[1], sys.argv[2]
slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in os.path.basename(d))[:40] or "project"
h = hashlib.sha256(d.encode()).hexdigest()[:10]
print(os.path.join(root, "gigga", "projects", f"{slug}-{h}", "state.json"))
' "$1" "$H/.config/opencode"
}
stop_all() { bash "$REPO/test/stop_servers.sh" 4476 4483 4484 >/dev/null 2>&1; sleep 1; }
trap stop_all EXIT

md "# GIGGA session-4 focused rerun — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json" 2>/dev/null
MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
[ -n "$MODEL" ] || MODEL=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -1)
# bootstrap config via the shared CLI (wizard itself is covered by e2e_wizard.sh)
CFGJSON=$(python3 -c 'import json; c=json.load(open("'"$H"'/.config/opencode/gigga/gigga.config.json")); c["tiers"]={"low":"'"$MODEL"'","medium":"'"$MODEL"'","high":"'"$MODEL"'"}; print(json.dumps(c))')
node "$REPO/dashboard/lib/shared.mjs" wizard "$H/.config/opencode" "$CFGJSON" >/dev/null
python3 - "$H/.config/opencode/opencode.json" <<'PY'
import json, sys
p = sys.argv[1]
cfg = {}
try: cfg = json.load(open(p))
except Exception: pass
cfg["permission"] = {"external_directory": {"*": "allow"}, "read": {"*": "allow"}, "edit": {"*": "allow"}, "bash": {"*": "allow"}, "question": "allow"}
json.dump(cfg, open(p, "w"), indent=2)
PY
mk_fx() { local d="$1"; mkdir -p "$d"; cp -r "$REPO/test/fixtures/." "$d/"; git -C "$d" init -q && git -C "$d" add -A && git -C "$d" -c user.email=f@t -c user.name=f commit -qm init; }
start_server() {
  stop_all
  ( cd "$SB" && HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null & )
  for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
  : > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
  sleep 2
}
sess_new() { curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$1\",\"agent\":\"${2:-gigga}\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
ask() { curl -s -X POST "$BASE/session/$1/prompt_async" -H 'content-type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"agent":"'"${2:-gigga}"'","parts":[{"type":"text","text":sys.argv[1]}]}))' "$3")" -o /dev/null -w "%{http_code}"; }
: "${ask_dummy:=}"
sse_json() { python3 - "$SSE" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("data: "):
        try: print(json.dumps(json.loads(line[6:])))
        except Exception: pass
PY
}
answer_first() { # answer newest pending question for any gigga session, with given pick mode
  local mode="${1:-first}" line rid labels label
  line=$(sse_json | python3 -c '
import json, sys
replied, pending = set(), []
for line in sys.stdin:
    d = json.loads(line)
    t, p = d.get("type"), d.get("properties", {})
    if t in ("question.replied", "question.rejected"): replied.add(p.get("requestID"))
    elif t == "question.asked":
        labels = [o.get("label", "") for q in p.get("questions", []) for o in q.get("options", [])]
        pending.append((p.get("id"), labels))
for rid, labels in pending:
    if rid not in replied:
        print(rid + "|" + ";".join(labels)); break
')
  [ -z "$line" ] && return 1
  rid=${line%%|*}; labels=${line#*|}
  label=$(python3 -c '
import sys
labels = [l for l in sys.argv[2].split(";") if l]
mode = sys.argv[1]; pick = labels[0] if labels else "yes"
if mode == "label": pick = sys.argv[3]
print(pick)
' "$mode" "$labels" "${2:-}")
  curl -s -X POST "$BASE/question/$rid/reply" -H 'content-type: application/json' -d "{\"answers\":[[\"$label\"]]}" -o /dev/null
  echo "answered [$rid] with: $label"
}
is_idle() {
  sse_json | python3 -c '
import json, sys
sid = sys.argv[1]; status = None
for line in sys.stdin:
    d = json.loads(line)
    if d.get("type") == "session.status" and d.get("properties", {}).get("sessionID") == sid:
        status = d["properties"].get("status", {}).get("type")
print("1" if status == "idle" else "")
' "$1"
}
watch() {
  local sid="$1" t="$2" mode="${3:-none}" w=0
  while [ "$w" -lt "$t" ]; do
    [ "$mode" != "none" ] && answer_first "$mode" >/dev/null
    [ -n "$(is_idle "$sid")" ] && return 0
    sleep 2; w=$((w+2))
  done
  echo "TIMEOUT(${t}s)"; return 1
}
final_text() {
  curl -s "$BASE/session/$1/message" | python3 -c '
import json, sys
try: msgs = json.load(sys.stdin)
except Exception: print("(unavailable)"); return
texts = []
for m in msgs:
    if m.get("info", {}).get("role") != "assistant": continue
    for p in m.get("parts", []):
        if p.get("type") == "text" and p.get("text", "").strip(): texts.append(p["text"])
print(texts[-1] if texts else "(none)")
'
}
tasks_for() {
  sse_json | python3 -c '
import json, sys
sid = sys.argv[1]; seen = {}; order = []
for line in sys.stdin:
    d = json.loads(line)
    if d.get("type") != "message.part.updated": continue
    p = d.get("properties", {}); part = p.get("part", {})
    if part.get("type") != "tool" or part.get("tool") != "task" or p.get("sessionID") != sid: continue
    st = part.get("state", {}); cid = part.get("callID")
    if st.get("status") not in ("running", "completed", "error"): continue
    if cid not in seen: seen[cid] = [st.get("input", {}).get("subagent_type", "?"), st.get("status")]; order.append(cid)
    else: seen[cid][1] = st.get("status")
for cid in order: print(seen[cid][0] + " " + seen[cid][1])
' "$1"
}

FX="$SB/fx1"; mk_fx "$FX"
start_server

# ============================================================ EDGE 1 ======
md ""
md "## Edge 1 — answer a pending question with 'fasttrack'"
E1=$(sess_new "$FX")
ask "$E1" gigga "Add a CSV export function to lib/parser.js and document it in README.md." >/dev/null
R=""
for _ in $(seq 1 90); do
  R=$(answer_first "label" "fasttrack")
  [ -n "$R" ] && break
  [ -n "$(is_idle "$E1")" ] && break
  sleep 2
done
md "answer: $R"
watch "$E1" 300 first >/dev/null
md "tasks:"; code "$(tasks_for "$E1")"
md "final:"; code "$(final_text "$E1")"
if tasks_for "$E1" | grep -q gigga-fasttrack; then md "**E1: PASS**"; else md "**E1: CHECK**"; fi

# ============================================================ EDGE 2 ======
md ""
md "## Edge 2 — kill -9 mid-execution"
E2=$(sess_new "$FX")
ask "$E2" gigga "Add input validation to parseArgs in src/argv-parser.ts and a shout() function in src/greet.ts." >/dev/null
E2S=$(pstate "$FX")
for _ in $(seq 1 120); do
  answer_first first >/dev/null 2>&1
  grep -q '"phase": *"executing"' "$E2S" 2>/dev/null && break
  sleep 2
done
md "state at kill time:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("phase:",d["phase"],[(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$E2S" 2>/dev/null)"
kill -9 "$(pgrep -f "opencode serve --port $PORT" | head -1)" 2>/dev/null; sleep 2
if [ -f "$E2S" ]; then
  if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$E2S" 2>/dev/null; then
    md "state.json after kill -9: VALID JSON (atomic writes held)"
  else
    md "state.json after kill -9: CORRUPT"
  fi
else
  md "state.json after kill -9: (not yet created — run had not reached executing; treating as no-op)"
fi
python3 - "$E2S" <<'PY'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
d["updatedAt"] = (datetime.datetime.utcnow() - datetime.timedelta(minutes=3)).isoformat() + "Z"
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
start_server
PROBE=$(sess_new "$FX" gigga-fasttrack)
ask "$PROBE" gigga-fasttrack "Reply with just: ok" >/dev/null
sleep 20
md "state after recovery:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("phase:", d["phase"]); print([(a["kind"], a["status"], a["task"][-28:]) for a in d["agents"]])' "$E2S")"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["phase"]=="failed" and any("interrupted" in a.get("task","") for a in d["agents"]) else 1)' "$E2S"; then
  md "**E2: PASS**"
else
  md "**E2: CHECK**"
fi

# ============================================================ EDGE 5 ======
md ""
md "## Edge 5 — two projects, per-project state + dashboards"
FX2="$SB/fx2"; mk_fx "$FX2"
E5A=$(sess_new "$FX"); E5B=$(sess_new "$FX2")
ask "$E5A" gigga "Add a clamp(a,min,max) helper to src/calc.ts." >/dev/null
ask "$E5B" gigga "Add a slug(text) function to lib/util.js." >/dev/null
# answer questions for either session until both idle
for _ in $(seq 1 150); do
  answer_first first >/dev/null
  A=$(is_idle "$E5A"); B=$(is_idle "$E5B")
  [ -n "$A" ] && [ -n "$B" ] && break
  sleep 2
done
S1=$(pstate "$FX"); S2=$(pstate "$FX2")
md "state files:"; code "$S1
$S2"
md "fx1 agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"]) for a in d["agents"]])' "$S1" 2>/dev/null || echo none)"
md "fx2 agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"]) for a in d["agents"]])' "$S2" 2>/dev/null || echo none)"
GIGGA_HOME="$H/.config/opencode" GIGGA_DATA_DIR="$H/.local/share/opencode" GIGGA_PROJECT_DIR="$FX" \
  node "$REPO/dashboard/server.mjs" --port 4483 --no-open > /dev/null 2>&1 &
GIGGA_HOME="$H/.config/opencode" GIGGA_DATA_DIR="$H/.local/share/opencode" GIGGA_PROJECT_DIR="$FX2" \
  node "$REPO/dashboard/server.mjs" --port 4484 --no-open > /dev/null 2>&1 &
sleep 2
md "dashboard A: $(curl -s http://127.0.0.1:4483/api/state | python3 -c 'import json,sys; d=json.load(sys.stdin); print("project:", d.get("project"), "| agents:", len(d["state"]["agents"]) if d["state"] else 0)')"
md "dashboard B: $(curl -s http://127.0.0.1:4484/api/state | python3 -c 'import json,sys; d=json.load(sys.stdin); print("project:", d.get("project"), "| agents:", len(d["state"]["agents"]) if d["state"] else 0)')"
bash "$REPO/test/stop_servers.sh" 4483 4484 >/dev/null 2>&1
if [ -f "$S1" ] && [ -f "$S2" ] && [ "$S1" != "$S2" ] \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["agents"] else 1)' "$S1" \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["agents"] else 1)' "$S2"; then
  md "**E5: PASS** — separate state files, each with its own agents"
else
  md "**E5: CHECK**"
fi

# ============================================================ EDGE 7 ======
md ""
md "## Edge 7 — worker fails mid-task"
for f in "$H"/.config/opencode/agents/gigga-worker-*.md; do
  sed -i '/^You are a GIGGA worker agent./i\
TEST MODE: immediately report Status: blocked with reason "injected failure"; do no work at all.' "$f"
done
start_server
E7=$(sess_new "$FX")
ask "$E7" gigga "Add an average(list) function to src/calc.ts." >/dev/null
watch "$E7" 420 first >/dev/null
E7S=$(pstate "$FX")
E7_MISSING=0; [ -f "$E7S" ] || E7_MISSING=1
md "state agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$E7S" 2>/dev/null)"
md "final:"; code "$(final_text "$E7")"
if [ "$E7_MISSING" = 1 ]; then
  md "**E7: CHECK** — no state file (see transcript)"
elif python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(a["kind"]=="worker" for a in d["agents"]) else 1)' "$E7S" 2>/dev/null && final_text "$E7" | grep -qi "blocked\|fail\|could not"; then
  md "**E7: PASS** — worker failure surfaced"
else
  md "**E7: CHECK**"
fi
for f in "$H"/.config/opencode/agents/gigga-worker-*.md; do sed -i '/^TEST MODE: immediately report Status: blocked/d' "$f"; done

# ============================================================ STATUS ======
md ""
md "## /gigga-status from a real run"
start_server
ST=$(sess_new "$FX")
ask "$ST" gigga "Add a median(list) function to src/calc.ts." >/dev/null
watch "$ST" 300 first >/dev/null
ST_JSON=$(GIGGA_HOME="$H/.config/opencode" node "$REPO/dashboard/lib/shared.mjs" status "$FX" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["state"]))')
md "state JSON:"; code "$(echo "$ST_JSON" | python3 -m json.tool | head -30)"
STS=$(sess_new "$FX" gigga-fasttrack)
ask "$STS" gigga-fasttrack "Print GIGGA status. Format: line 1 phase + pending question; quote originalRequest (100 chars); table of agents (number/kind, tier, status, task 60 chars, session id); if agents empty say no run yet. State JSON: $ST_JSON" >/dev/null
watch "$STS" 180 none >/dev/null
md "agent-formatted /gigga-status output:"; code "$(final_text "$STS")"

md ""
md "--- end of focused rerun ---"
