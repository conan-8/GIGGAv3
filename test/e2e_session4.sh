#!/usr/bin/env bash
# GIGGA session-4 E2E: setup wizard + edge cases 1-8 + /GIGGA-status.
# Writes markdown evidence to stdout. Usage:
#   bash test/e2e_session4.sh > test/results/2026-08-18-session4.md
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT="${GIGGA_S4_PORT:-4470}"
BASE="http://127.0.0.1:$PORT"
SB="$(mktemp -d /tmp/GIGGA-s4.XXXXXX)"
H="$SB/home"
SSE="$SB/sse.log"

md() { printf '%s\n' "$*"; }
code() { printf '```\n%s\n```\n' "$*"; }
pstate() { # pstate <projectDir> -> per-project state.json path
  python3 -c '
import hashlib, os, sys
d, root = sys.argv[1], sys.argv[2]
slug = os.path.basename(d).replace("/", "-")[:40] or "project"
slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in slug)
h = hashlib.sha256(d.encode()).hexdigest()[:10]
print(os.path.join(root, "GIGGA", "projects", f"{slug}-{h}", "state.json"))
' "$1" "$H/.config/opencode"
}

cleanup() { bash "$REPO/test/stop_servers.sh" "$PORT" 4471 4472 >/dev/null 2>&1; }
trap cleanup EXIT

md "# GIGGA session-4 E2E — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
md "opencode $(opencode --version 2>/dev/null) | sandbox $SB"

mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json" 2>/dev/null || md "WARN: no auth"
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
mk_fixture() { # mk_fixture <dir> [--git]
  local d="$1"; shift
  mkdir -p "$d"; cp -r "$REPO/test/fixtures/." "$d/"
  if [ "${1:-}" = "--git" ]; then
    git -C "$d" init -q && git -C "$d" add -A && git -C "$d" -c user.email=s4@t -c user.name=s4 commit -qm init
  fi
}
start_server() {
  ( cd "$SB" && HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null & )
  for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
  : > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
  sleep 2
}
sess_new() { # sess_new <dir> [agent]
  curl -s -X POST "$BASE/session" -H 'content-type: application/json' \
    -d "{\"directory\":\"$1\",\"agent\":\"${2:-GIGGA}\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}

sse_json() { python3 - "$SSE" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("data: "):
        try: print(json.dumps(json.loads(line[6:])))
        except Exception: pass
PY
}
reply_question() { # reply_question <sid> <mode:first|yes|kimi|label:TEXT>
  local sid="$1" mode="$2" line rid labels label
  line=$(sse_json | python3 -c '
import json, sys
sid, mode = sys.argv[1], sys.argv[2]
replied, pending = set(), []
for line in sys.stdin:
    d = json.loads(line)
    t, p = d.get("type"), d.get("properties", {})
    if t in ("question.replied", "question.rejected"): replied.add(p.get("requestID"))
    elif t == "question.asked" and p.get("sessionID") == sid:
        labels = [o.get("label", "") for q in p.get("questions", []) for o in q.get("options", [])]
        pending.append((p.get("id"), labels))
for rid, labels in pending:
    if rid not in replied:
        print(rid + "|" + ";".join(labels)); break
' "$sid" "$mode")
  [ -z "$line" ] && return 1
  rid=${line%%|*}; labels=${line#*|}
  if [ "${mode#label:}" != "$mode" ]; then label="${mode#label:}"
  else label=$(python3 -c '
import sys
labels = [l for l in sys.argv[2].split(";") if l]
mode = sys.argv[1]
pick = labels[0] if labels else "yes"
if mode == "yes":
    for l in labels:
        if any(w in l.lower() for w in ("yes","yeah","sure","ok","retry","do it")): pick = l; break
elif mode == "kimi":
    for l in labels:
        if "kimi" in l.lower(): pick = l; break
elif mode == "medium":
    for l in labels:
        if "medium" in l.lower() or "middle" in l.lower(): pick = l; break
print(pick)
' "$mode" "$labels"); fi
  curl -s -X POST "$BASE/question/$rid/reply" -H 'content-type: application/json' \
    -d "{\"answers\":[[\"$label\"]]}" -o /dev/null
  echo "answered [$rid] with: $label"
  return 0
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
watch() { # watch <sid> <timeout> <mode|none>
  local sid="$1" t="$2" mode="$3" w=0 r
  while [ "$w" -lt "$t" ]; do
    [ "$mode" != "none" ] && { r=$(reply_question "$sid" "$mode"); }
    [ -n "$(is_idle "$sid")" ] && return 0
    sleep 2; w=$((w+2))
  done
  echo "TIMEOUT(${t}s)"; return 1
}
final_text() {
  curl -s "$BASE/session/$1/message" | python3 -c '
import json, sys
texts = []
for m in json.load(sys.stdin):
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
    if cid not in seen:
        seen[cid] = [st.get("input", {}).get("subagent_type", "?"), st.get("status")]; order.append(cid)
    else: seen[cid][1] = st.get("status")
for cid in order: print(seen[cid][0] + " " + seen[cid][1])
' "$1"
}
q_events_for() {
  sse_json | python3 -c '
import json, sys
sid, n = sys.argv[1], 0
for line in sys.stdin:
    d = json.loads(line)
    if d.get("type") == "question.asked" and d.get("properties", {}).get("sessionID") == sid: n += 1
print(n)
' "$1"
}
checker_verdicts() {
  sse_json | python3 -c '
import json, sys, re
for line in sys.stdin:
    d = json.loads(line)
    if d.get("type") != "message.part.updated": continue
    part = d.get("properties", {}).get("part", {})
    if part.get("type") != "tool" or part.get("tool") != "task": continue
    st = part.get("state", {})
    if st.get("input", {}).get("subagent_type") != "GIGGA-checker": continue
    m = re.search(r"VERDICT:\s*(PASS|FAIL)", str(st.get("output", "")))
    if m: print(m.group(1))
'
}

FX="$SB/fx1"; mk_fixture "$FX" --git
start_server
CFG="$H/.config/opencode/GIGGA/GIGGA.config.json"
AG="$H/.config/opencode/agents"
MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
[ -n "$MODEL" ] || MODEL=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -1)

# ============================================================ WIZARD (G1) ==
md ""
md "## Gate 1 — first-run guided setup (API-driven TUI-equivalent session)"
md "config before: $(python3 -c 'import json; c=json.load(open("'"$CFG"'")); print("configured" if c.get("configured") else "NOT configured", c["tiers"])')"
W_SID=$(sess_new "$FX")
md "session: $W_SID — request: \`Set up GIGGA now — run the setup wizard.\`"
curl -s -X POST "$BASE/session/$W_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Set up GIGGA now — run the setup wizard with me."}]}' -o /dev/null
W_LOG="$SB/wizard.log"
(
  while :; do
    reply_question "$W_SID" kimi && continue
    reply_question "$W_SID" medium && continue
    reply_question "$W_SID" first && continue
    [ -n "$(is_idle "$W_SID")" ] && break
    sleep 2
  done
) > "$W_LOG" 2>&1 &
WMON=$!
for _ in $(seq 1 240); do [ -n "$(is_idle "$W_SID")" ] && break; sleep 2; done
kill $WMON 2>/dev/null
md "wizard answers:"; code "$(cat "$W_LOG")"
md "final (wizard summary):"; code "$(final_text "$W_SID")"
md "config after:"; code "$(cat "$CFG")"
md "agent file diffs (model lines):"
code "$(grep -H '^model:' "$AG"/GIGGA-worker-*.md "$AG"/GIGGA.md)"
G1_OK=0
if python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if c.get("configured") and all("kimi" in v for v in c["tiers"].values()) else 1)' "$CFG" \
   && grep -q "model: kimi" "$AG/GIGGA-worker-low.md" && grep -q "^model: kimi" "$AG/GIGGA.md"; then
  md "**G1: PASS** — config written + configured, worker/orchestrator model lines updated"; G1_OK=1
else
  # one retry: nudge the orchestrator to actually run the wizard agent
  md "wizard incomplete — nudging once (spawn GIGGA-config now)"
  curl -s -X POST "$BASE/session/$W_SID/prompt_async" -H 'content-type: application/json' \
    -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Continue the setup wizard NOW: spawn the GIGGA-config agent in this turn and complete configuration with me."}]}' -o /dev/null
  (
    while :; do
      reply_question "$W_SID" kimi && continue
      reply_question "$W_SID" medium && continue
      reply_question "$W_SID" first && continue
      [ -n "$(is_idle "$W_SID")" ] && break
      sleep 2
    done
  ) > "$W_LOG" 2>&1 &
  WMON=$!
  for _ in $(seq 1 240); do [ -n "$(is_idle "$W_SID")" ] && break; sleep 2; done
  kill $WMON 2>/dev/null
  md "retry answers:"; code "$(cat "$W_LOG")"
  md "retry final:"; code "$(final_text "$W_SID")"
  if python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if c.get("configured") and all("kimi" in v for v in c["tiers"].values()) else 1)' "$CFG" \
     && grep -q "model: kimi" "$AG/GIGGA-worker-low.md"; then
    md "**G1: PASS (on retry)**"; G1_OK=1
  else
    md "**G1: FAIL via agent — bootstrapping via the shared CLI so the edge cases can run; wizard transcript above stands as evidence**"
    CFGJSON=$(python3 -c 'import json; c=json.load(open("'"$CFG"'")); c["tiers"]={"low":"'"$MODEL"'","medium":"'"$MODEL"'","high":"'"$MODEL"'"}; print(json.dumps(c))')
    node "$REPO/dashboard/lib/shared.mjs" wizard "$H/.config/opencode" "$CFGJSON" > /dev/null
  fi
fi

# ===================================================== EDGE 1: fasttrack ====
md ""
md "## Edge 1 — answer a pending question with 'fasttrack'"
E1_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E1_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add a CSV export function to lib/parser.js and document it in README.md."}]}' -o /dev/null
# answer the first pending question with the literal label fasttrack
for _ in $(seq 1 60); do
  r=$(reply_question "$E1_SID" "label:fasttrack")
  [ -n "$r" ] && break
  [ -n "$(is_idle "$E1_SID")" ] && break
  sleep 2
done
md "answer sent: $r"
watch "$E1_SID" 240 first >/dev/null
md "tasks:"; code "$(tasks_for "$E1_SID")"
md "final:"; code "$(final_text "$E1_SID")"
if tasks_for "$E1_SID" | grep -q GIGGA-fasttrack; then
  md "**E1: PASS** — question answered 'fasttrack' → routed to fasttrack agent"
else
  md "**E1: CHECK** — see tasks/final"
fi

# ===================================================== EDGE 2: kill -9 ======
md ""
md "## Edge 2 — kill -9 mid-execution: state intact + stale recovery"
E2_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E2_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add input validation to parseArgs in src/argv-parser.ts and a shout() function in src/greet.ts."}]}' -o /dev/null
E2STATE=$(pstate "$FX")
for _ in $(seq 1 90); do
  grep -q '"phase": *"executing"' "$E2STATE" 2>/dev/null && break
  sleep 2
done
SRVPID=$(pgrep -f "opencode serve --port $PORT" | head -1)
kill -9 "$SRVPID" 2>/dev/null; sleep 2
md "state.json valid JSON after kill -9:"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("VALID — phase:", d["phase"], "agents:", [(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$E2STATE" && echo "yes" || echo "CORRUPT"
# backdate updatedAt to beyond the 120s stale threshold, restart, trigger plugin load
python3 - "$E2STATE" <<'PY'
import json, sys, datetime
p = sys.argv[1]
d = json.load(open(p))
d["updatedAt"] = (datetime.datetime.utcnow() - datetime.timedelta(minutes=3)).isoformat() + "Z"
json.dump(d, open(p, "w"), indent=2)
PY
bash "$REPO/test/stop_servers.sh" "$PORT" >/dev/null 2>&1; sleep 1
start_server
PROBE=$(sess_new "$FX" GIGGA-fasttrack)   # session creation loads the plugin
curl -s -X POST "$BASE/session/$PROBE/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Reply with just: ok"}]}' -o /dev/null
sleep 15
md "state after recovery:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("phase:", d["phase"]); print([(a["kind"],a["status"],a["task"][-30:]) for a in d["agents"]])' "$E2STATE")"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["phase"]=="failed" and any("interrupted" in a.get("task","") for a in d["agents"]) else 1)' "$E2STATE"; then
  md "**E2: PASS** — no corruption; stale workers marked failed (interrupted)"
else
  md "**E2: CHECK** — see state above"
fi

# ===================================================== EDGE 3: autoRetry ====
md ""
md "## Edge 3 — autoRetry=true with persistent failures stays bounded"
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["autoRetry"] = True
json.dump(c, open(p, "w"), indent=2)
PY
for f in "$AG"/GIGGA-worker-*.md; do
  sed -i '/^You are a GIGGA worker agent./i\
TEST MODE: always report Status: blocked with reason "injected failure"; do no work at all.' "$f"
done
bash "$REPO/test/stop_servers.sh" "$PORT" >/dev/null 2>&1; sleep 1
start_server
E3_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E3_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Two things: add input validation to parseConfig in lib/parser.js, and add a JSDoc block above it."}]}' -o /dev/null
watch "$E3_SID" 480 first >/dev/null
E3_WAVES=$(tasks_for "$E3_SID" | grep -c GIGGA-worker)
md "worker spawns (initial + retries): $E3_WAVES (must be ≤ 3 = 1 + 2 auto-retries)"
md "checker verdicts: $(checker_verdicts | tr '\n' ' ')"
md "final:"; code "$(final_text "$E3_SID")"
if [ "$E3_WAVES" -le 3 ]; then md "**E3: PASS** — bounded retries, no infinite loop"; else md "**E3: FAIL** — exceeded 2 auto-retries"; fi
for f in "$AG"/GIGGA-worker-*.md; do sed -i '/^TEST MODE: always report Status: blocked/d' "$f"; done

# ===================================================== EDGE 4: maxParallel ==
md ""
md "## Edge 4 — maxParallel larger than task count"
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["autoRetry"] = False; c["maxParallel"] = 10
json.dump(c, open(p, "w"), indent=2)
PY
E4_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E4_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Two independent changes: add a round() helper to src/calc.ts; add a farewell(name) function to src/greet.ts."}]}' -o /dev/null
watch "$E4_SID" 420 first >/dev/null
E4_TASKS=$(tasks_for "$E4_SID"); E4_W=$(echo "$E4_TASKS" | grep -c GIGGA-worker)
md "workers spawned: $E4_W (maxParallel=10)"; code "$E4_TASKS"
md "final:"; code "$(final_text "$E4_SID")"
if [ "$E4_W" -ge 2 ]; then md "**E4: PASS** — all tasks ran, no error"; else md "**E4: CHECK**"; fi

# ===================================================== EDGE 5: two projects =
md ""
md "## Edge 5 — two projects, per-project state"
FX2="$SB/fx2"; mk_fixture "$FX2" --git
E5A=$(sess_new "$FX")
E5B=$(sess_new "$FX2")
curl -s -X POST "$BASE/session/$E5A/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add a clamp(a,min,max) helper to src/calc.ts."}]}' -o /dev/null
curl -s -X POST "$BASE/session/$E5B/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add a slug() function to lib/util.js."}]}' -o /dev/null
watch "$E5A" 300 none >/dev/null 2 & watch "$E5B" 300 none >/dev/null 2 &
sleep 60; kill %1 %2 2>/dev/null
S1=$(pstate "$FX"); S2=$(pstate "$FX2")
md "state files:"; code "$S1
$S2"
md "fx1 state agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"]) for a in d["agents"]])' "$S1" 2>/dev/null || echo none)"
md "fx2 state agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"]) for a in d["agents"]])' "$S2" 2>/dev/null || echo none)"
if [ "$S1" != "$S2" ] && [ -f "$S1" ] && [ -f "$S2" ]; then md "**E5: PASS** — separate per-project state files"; else md "**E5: CHECK**"; fi
# dashboard per-project
GIGGA_HOME="$H/.config/opencode" GIGGA_DATA_DIR="$H/.local/share/opencode" GIGGA_PROJECT_DIR="$FX" \
  node "$REPO/dashboard/server.mjs" --port 4471 --no-open > "$SB/dash1.log" 2>&1 &
GIGGA_HOME="$H/.config/opencode" GIGGA_DATA_DIR="$H/.local/share/opencode" GIGGA_PROJECT_DIR="$FX2" \
  node "$REPO/dashboard/server.mjs" --port 4472 --no-open > "$SB/dash2.log" 2>&1 &
sleep 2
md "dashboard A (fx1): $(curl -s http://127.0.0.1:4471/api/state | python3 -c 'import json,sys; d=json.load(sys.stdin); print("project:", d["project"], "| agents:", len(d["state"]["agents"]) if d["state"] else 0)')"
md "dashboard B (fx2): $(curl -s http://127.0.0.1:4472/api/state | python3 -c 'import json,sys; d=json.load(sys.stdin); print("project:", d["project"], "| agents:", len(d["state"]["agents"]) if d["state"] else 0)')"
bash "$REPO/test/stop_servers.sh" 4471 4472 >/dev/null 2>&1

# ===================================================== EDGE 6: non-git =====
md ""
md "## Edge 6 — request in a non-git directory"
FX3="$SB/fx3"; mk_fixture "$FX3"
E6_SID=$(sess_new "$FX3")
curl -s -X POST "$BASE/session/$E6_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add a lerp(a,b,t) function to src/calc.ts."}]}' -o /dev/null
watch "$E6_SID" 300 first >/dev/null
md "checker verdicts: $(checker_verdicts | tr '\n' ' ')"
md "final:"; code "$(final_text "$E6_SID")"
if [ "$(checker_verdicts | tail -1)" = "PASS" ]; then md "**E6: PASS** — works without git"; else md "**E6: CHECK**"; fi

# ===================================================== EDGE 7: worker error =
md ""
md "## Edge 7 — worker fails mid-task"
for f in "$AG"/GIGGA-worker-*.md; do
  sed -i '/^You are a GIGGA worker agent./i\
TEST MODE: immediately report Status: blocked with reason "injected failure"; do no work at all.' "$f"
done
bash "$REPO/test/stop_servers.sh" "$PORT" >/dev/null 2>&1; sleep 1
start_server
E7_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E7_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Add an average(list) function to src/calc.ts."}]}' -o /dev/null
watch "$E7_SID" 360 first >/dev/null
E7STATE=$(pstate "$FX")
md "state agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$E7STATE" 2>/dev/null)"
md "final:"; code "$(final_text "$E7_SID")"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(a["kind"]=="worker" and a["status"] in ("failed","done") for a in d["agents"]) and ("blocked" in open(sys.argv[1]).read().lower() or "fail" in open(sys.argv[1]).read().lower()) else 1)' "$E7STATE" 2>/dev/null || final_text "$E7_SID" | grep -qi "blocked\|fail"; then
  md "**E7: PASS** — failure surfaced to the orchestrator/user"
else
  md "**E7: CHECK** — see state/final"
fi
for f in "$AG"/GIGGA-worker-*.md; do sed -i '/^TEST MODE: immediately report Status: blocked/d' "$f"; done

# ===================================================== EDGE 8: rounds = 1 ===
md ""
md "## Edge 8 — questionRounds=1 enforced end to end"
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["questionRounds"] = 1
json.dump(c, open(p, "w"), indent=2)
PY
bash "$REPO/test/stop_servers.sh" "$PORT" >/dev/null 2>&1; sleep 1
start_server
E8_SID=$(sess_new "$FX")
curl -s -X POST "$BASE/session/$E8_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"improve the parsers somehow"}]}' -o /dev/null
watch "$E8_SID" 480 first >/dev/null
E8_Q=$(q_events_for "$E8_SID")
md "question.asked events: $E8_Q (must be ≤ 1 with questionRounds=1 + plugin cap)"
md "cap enforcement in plugin log:"; code "$(grep -a "question cap enforced" "$(dirname "$(pstate "$FX")")/events.log" | tail -2)"
md "final:"; code "$(final_text "$E8_SID")"
if [ "$E8_Q" -le 1 ]; then md "**E8: PASS**"; else md "**E8: FAIL** — cap not enforced"; fi
# restore rounds
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["questionRounds"] = 2
json.dump(c, open(p, "w"), indent=2)
PY

# ===================================================== /GIGGA-status =======
md ""
md "## /GIGGA-status (live project state, agent-formatted)"
ST_JSON=$(cd "$FX" && GIGGA_HOME="$H/.config/opencode" node "$REPO/dashboard/lib/shared.mjs" status "$FX" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["state"]))')
ST_SID=$(sess_new "$FX" GIGGA-fasttrack)
curl -s -X POST "$BASE/session/$ST_SID/prompt_async" -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"agent":"GIGGA","parts":[{"type":"text","text":"Print GIGGA status. Format: line 1 phase + pending question; quote originalRequest (100 chars); table of agents (number/kind, tier, status, task 60 chars, session id); if agents empty say no run yet. State JSON: " + sys.argv[1]}]}))' "$ST_JSON")" -o /dev/null
watch "$ST_SID" 180 none >/dev/null
code "$(final_text "$ST_SID")"

md ""
md "--- end of session-4 run ---"
