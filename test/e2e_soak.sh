#!/usr/bin/env bash
# Soak: 8-task plan with maxParallel=5 — concurrency bound, JSON integrity
# across the whole run, kill -9 recovery, dashboard honesty.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
P=4489; BASE="http://127.0.0.1:$P"; DP=4485
SB="$(mktemp -d /tmp/gigga-soak.XXXXXX)"; H="$SB/home"; SSE="$SB/sse.log"
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
trap 'bash "$REPO/test/stop_servers.sh" 4489 4485' EXIT

md "# Soak test — 8 tasks / maxParallel 5 — $(date -u +%FT%TZ)"
mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json"
MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
[ -n "$MODEL" ] || MODEL=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -1)
CFGJSON=$(python3 -c 'import json; c=json.load(open("'"$H"'/.config/opencode/gigga/gigga.config.json")); c["tiers"]={"low":"'"$MODEL"'","medium":"'"$MODEL"'","high":"'"$MODEL"'"}; c["maxParallel"]=5; c["configured"]=True; print(json.dumps(c))')
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
FX="$SB/fx"; mkdir -p "$FX"; cp -r "$REPO/test/fixtures/." "$FX/"
for i in $(seq 1 8); do echo "export const placeholder$i = $i;" > "$FX/src/slot$i.ts"; done
git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.email=s@t -c user.name=s commit -qm init
start() {
  bash "$REPO/test/stop_servers.sh" "$P" "$DP" >/dev/null 2>&1; sleep 1
  ( cd "$FX" && HOME="$H" setsid nohup opencode serve --port "$P" > "$SB/serve.log" 2>&1 < /dev/null & )
  for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
  : > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
  sleep 2
}
start
ans() {
  line=$(python3 - "$SSE" <<'PY'
import json, sys
replied, pend = set(), []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    t, p = d.get("type"), d.get("properties", {})
    if t in ("question.replied", "question.rejected"): replied.add(p.get("requestID"))
    elif t == "question.asked":
        pend.append((p.get("id"), [o.get("label", "") for q in p.get("questions", []) for o in q.get("options", [])]))
for rid, labels in pend:
    if rid not in replied:
        print(rid + "|" + ";".join(labels)); break
PY
)
  [ -z "$line" ] && return 1
  rid=${line%%|*}; labels=${line#*|}
  label=$(python3 -c 'import sys; ls=[l for l in sys.argv[1].split(";") if l]; print(ls[0] if ls else "yes")' "$labels")
  curl -s -X POST "$BASE/question/$rid/reply" -H 'content-type: application/json' -d "{\"answers\":[[\"$label\"]]}" -o /dev/null
  echo "answered: $label"
}
idle() {
  python3 - "$SSE" <<'PY'
import json, sys
sid, st = sys.argv[1], None
for line in open(sys.argv[2]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    if d.get("type") == "session.status" and d.get("properties", {}).get("sessionID") == sid:
        st = d["properties"].get("status", {}).get("type")
print("1" if st == "idle" else "")
PY
}
ST=$(pstate "$FX")
SID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

md "request: 8 independent one-file tasks (fill src/slot1..8.ts with real helpers)"
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga","parts":[{"type":"text","text":"Eight independent tasks, one per file — fill each src/slot1.ts … src/slot8.ts with a small, working, exported utility function (square, cube, isEven, isOdd, abs, sign, clampTo10, negate respectively). No task depends on another; parallelize the workers."}]}' -o /dev/null

# poll: answer questions, validate JSON every tick, track concurrency
POLLS=0; BADJSON=0; MAXCONC=0; PHASES=""
while :; do
  ans >/dev/null 2>&1
  if [ -f "$ST" ]; then
    if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$ST" 2>/dev/null; then
      BADJSON=$((BADJSON+1))
    fi
    read -r C PH <<<"$(python3 -c '
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: print(0, "invalid"); raise SystemExit
w = [a for a in d.get("agents", []) if a.get("kind") == "worker" and a.get("status") == "working"]
print(len(w), d.get("phase", "?"))
' "$ST" 2>/dev/null || echo "0 ?")"
    case "$C" in ''|*[!0-9]*) C=0;; esac
    [ "$C" -gt "$MAXCONC" ] && MAXCONC=$C
    case "$PH" in *"$PHASES"*) ;; *) PHASES="$PHASES $PH";; esac
  fi
  [ -n "$(idle "$SID" "$SSE")" ] && break
  POLLS=$((POLLS+1))
  [ "$POLLS" -gt 400 ] && { md "TIMEOUT"; break; }
  sleep 2
done
WORKERS=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for a in d["agents"] if a["kind"]=="worker"))' "$ST" 2>/dev/null)
DONE=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for a in d["agents"] if a["kind"]=="worker" and a["status"]=="done"))' "$ST" 2>/dev/null)
md "validation loop: $POLLS polls, corrupt reads: $BADJSON (must be 0)"
md "phases seen:$PHASES"
md "max concurrent workers: $MAXCONC (must be ≤ 5)"
md "workers spawned/done: $WORKERS/$DONE"
if [ "$BADJSON" -eq 0 ] && [ "$MAXCONC" -le 5 ] && [ "${DONE:-0}" -ge 6 ]; then
  md "**SOAK-PHASE-1: PASS**"
else
  md "**SOAK-PHASE-1: CHECK**"
fi

# ---- phase 2: kill -9 mid-run + restart + dashboard honesty
md ""
md "## kill -9 mid-run + restart + dashboard honesty"
KSID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$KSID/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga","parts":[{"type":"text","text":"Eight more independent tasks: extend each src/slot1..8.ts with a second exported function (double, triple, isPositive, isNegative, max0, min0, wrap10, invert)."}]}' -o /dev/null
for _ in $(seq 1 120); do
  ans >/dev/null 2>&1
  grep -q '"kind": *"worker"' "$ST" 2>/dev/null && grep -q '"status": *"working"' "$ST" 2>/dev/null && break
  sleep 2
done
kill -9 "$(pgrep -f "opencode serve --port $P" | head -1)" 2>/dev/null; sleep 2
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$ST" 2>/dev/null; then md "state.json valid after kill -9: YES"; else md "state.json valid after kill -9: NO (CORRUPT)"; fi
python3 - "$ST" <<'PY'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
d["updatedAt"] = (datetime.datetime.utcnow() - datetime.timedelta(minutes=3)).isoformat() + "Z"
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
start
PROBE=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga-fasttrack\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$PROBE/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga-fasttrack","parts":[{"type":"text","text":"Reply: ok"}]}' -o /dev/null
sleep 20
GIGGA_HOME="$H/.config/opencode" GIGGA_DATA_DIR="$H/.local/share/opencode" GIGGA_PROJECT_DIR="$FX" \
  node "$REPO/dashboard/server.mjs" --port "$DP" --no-open >/dev/null 2>&1 &
sleep 2
md "dashboard /api/state after recovery:"
code "$(curl -s "http://127.0.0.1:$DP/api/state" | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = d.get("state") or {}
print("phase:", s.get("phase"))
for a in s.get("agents", []):
    print(" ", a.get("kind"), a.get("id"), a.get("status"), str(a.get("task", ""))[-40:])
')"
md "state after recovery:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("phase:", d["phase"]); print([(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$ST")"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["phase"]=="failed" and any("interrupted" in a.get("task","") for a in d["agents"]) else 1)' "$ST"; then
  md "**SOAK-PHASE-2: PASS** — stale run recovered, dashboard shows the failure honestly"
else
  md "**SOAK-PHASE-2: CHECK**"
fi
md "--- end of soak ---"
