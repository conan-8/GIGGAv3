#!/usr/bin/env bash
# Final micro-verifications: E7 (worker failure surfaced) + /gigga-status paste.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
P=4479; BASE="http://127.0.0.1:$P"
SB="$(mktemp -d /tmp/gigga-fin.XXXXXX)"; H="$SB/home"; SSE="$SB/sse.log"
md() { printf '%s\n' "$*"; }
code() { printf '```\n%s\n```\n' "$*"; }
trap 'bash "$REPO/test/stop_servers.sh" 4479' EXIT
md "# Final session-4 micro-verifications — $(date -u +%FT%TZ)"
mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json"
MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
CFGJSON=$(python3 -c 'import json; c=json.load(open("'"$H"'/.config/opencode/gigga/gigga.config.json")); c["tiers"]={"low":"'"$MODEL"'","medium":"'"$MODEL"'","high":"'"$MODEL"'"}; print(json.dumps(c))')
node "$REPO/dashboard/lib/shared.mjs" wizard "$H/.config/opencode" "$CFGJSON" >/dev/null
python3 - "$H/.config/opencode/opencode.json" <<'PY'
import json, sys
p=sys.argv[1]; cfg={}
try: cfg=json.load(open(p))
except Exception: pass
cfg["permission"]={"external_directory":{"*":"allow"},"read":{"*":"allow"},"edit":{"*":"allow"},"bash":{"*":"allow"},"question":"allow"}
json.dump(cfg,open(p,"w"),indent=2)
PY
FX="$SB/fx"; mkdir -p "$FX"; cp -r "$REPO/test/fixtures/." "$FX/"
git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.email=f@t -c user.name=f commit -qm init
for f in "$H"/.config/opencode/agents/gigga-worker-*.md; do
  sed -i '/^You are a GIGGA worker agent./i\
TEST MODE: immediately report Status: blocked with reason "injected failure"; do no work at all.' "$f"
done
( cd "$FX" && HOME="$H" setsid nohup opencode serve --port "$P" > "$SB/serve.log" 2>&1 < /dev/null & )
for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
: > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
sleep 2
ft() { curl -s "$BASE/session/$1/message" | python3 -c '
import json, sys
try: msgs=json.load(sys.stdin)
except Exception: print("(unavailable)"); raise SystemExit
t=[]
for m in msgs:
    if m.get("info",{}).get("role")!="assistant": continue
    for p in m.get("parts",[]):
        if p.get("type")=="text" and p.get("text","").strip(): t.append(p["text"])
print(t[-1] if t else "(none)")
'; }
ans() {
  line=$(python3 - "$SSE" <<'PY'
import json, sys
replied, pend = set(), []
for line in open(sys.argv[1]):
    line=line.strip()
    if not line.startswith("data: "): continue
    try: d=json.loads(line[6:])
    except Exception: continue
    t,p=d.get("type"),d.get("properties",{})
    if t in ("question.replied","question.rejected"): replied.add(p.get("requestID"))
    elif t=="question.asked":
        pend.append((p.get("id"), [o.get("label","") for q in p.get("questions",[]) for o in q.get("options",[])]))
for rid,labels in pend:
    if rid not in replied:
        print(rid+"|"+";".join(labels)); break
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
sid=sys.argv[1]; st=None
for line in open(sys.argv[2]):
    line=line.strip()
    if not line.startswith("data: "): continue
    try: d=json.loads(line[6:])
    except Exception: continue
    if d.get("type")=="session.status" and d.get("properties",{}).get("sessionID")==sid:
        st=d["properties"].get("status",{}).get("type")
print("1" if st=="idle" else "")
PY
}
md "## E7 — worker fails mid-task (sabotaged worker reports blocked)"
SID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga","parts":[{"type":"text","text":"Add an average(list) function to src/calc.ts."}]}' -o /dev/null
W=0
while [ $W -lt 420 ]; do ans >/dev/null 2>&1; [ -n "$(idle "$SID" "$SSE")" ] && break; sleep 2; W=$((W+2)); done
ST=$(python3 -c '
import hashlib, os, sys
d, root = sys.argv[1], sys.argv[2]
slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in os.path.basename(d))[:40] or "project"
h = hashlib.sha256(d.encode()).hexdigest()[:10]
print(os.path.join(root, "gigga", "projects", f"{slug}-{h}", "state.json"))
' "$FX" "$H/.config/opencode")
md "state agents:"; code "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print([(a["kind"],a["id"],a["status"]) for a in d["agents"]])' "$ST" 2>/dev/null || echo none)"
md "final:"; code "$(ft "$SID")"
for f in "$H"/.config/opencode/agents/gigga-worker-*.md; do sed -i '/^TEST MODE: immediately report Status: blocked/d' "$f"; done

md "## /gigga-status — live project state (CLI + agent-formatted)"
STJ=$(GIGGA_HOME="$H/.config/opencode" node "$REPO/dashboard/lib/shared.mjs" status "$FX" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["state"]))')
S2=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga-fasttrack\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$S2/prompt_async" -H 'content-type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"agent":"gigga-fasttrack","parts":[{"type":"text","text":"Print GIGGA status. Format: line 1 phase + pending question; quote originalRequest (100 chars); table of agents (number/kind, tier, status, task 60 chars, session id); if agents empty say no run yet. State JSON: " + sys.argv[1]}]}))' "$STJ")" -o /dev/null
W=0
while [ $W -lt 180 ]; do [ -n "$(idle "$S2" "$SSE")" ] && break; sleep 2; W=$((W+2)); done
code "$(ft "$S2")"
md "--- end ---"
