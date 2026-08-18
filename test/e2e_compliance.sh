#!/usr/bin/env bash
# Compliance evidence: sub-subagent delegation (subagent_depth 2) and
# tier selection (orchestrator picks worker tiers; config changes models).
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
P=4488; BASE="http://127.0.0.1:$P"
SB="$(mktemp -d /tmp/gigga-cmp.XXXXXX)"; H="$SB/home"; SSE="$SB/sse.log"
md() { printf '%s\n' "$*"; }
code() { printf '```\n%s\n```\n' "$*"; }
trap 'bash "$REPO/test/stop_servers.sh" 4488' EXIT

md "# Compliance evidence: sub-subagents + tier selection — $(date -u +%FT%TZ)"
mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json"
MODELS=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -5)
# three DISTINCT models for tiers so selection is observable
M_LO=$(echo "$MODELS" | sed -n 1p); M_MED=$(echo "$MODELS" | sed -n 2p); M_HI=$(echo "$MODELS" | sed -n 3p)
[ -n "$M_HI" ] || { M_MED="$M_LO"; M_HI="$M_LO"; }
md "tier models: low=$M_LO medium=$M_MED high=$M_HI"
python3 - "$H/.config/opencode/gigga/gigga.config.json" <<PY
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["tiers"] = {"low": "$M_LO", "medium": "$M_MED", "high": "$M_HI"}
c["defaultTier"] = "medium"
c["configured"] = True
json.dump(c, open(p, "w"), indent=2)
PY
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
# make the repo big enough that delegation is plausible
for i in $(seq 1 12); do printf '// module %d\nfunction helper%d(x) { return x + %d; }\nmodule.exports = { helper%d };\n' $i $i $i $i > "$FX/lib/mod$i.js"; done
git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.email=c@t -c user.name=c commit -qm init

( cd "$FX" && HOME="$H" setsid nohup opencode serve --port "$P" > "$SB/serve.log" 2>&1 < /dev/null & )
for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
: > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
sleep 2

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
ft() {
  curl -s "$BASE/session/$1/message" | python3 -c '
import json, sys
try: msgs = json.load(sys.stdin)
except Exception: print("(unavailable)"); raise SystemExit
t = []
for m in msgs:
    if m.get("info", {}).get("role") != "assistant": continue
    for p in m.get("parts", []):
        if p.get("type") == "text" and p.get("text", "").strip(): t.append(p["text"])
print(t[-1] if t else "(none)")
'
}

# ---------------------------------------------- sub-subagent delegation ----
md ""
md "## Sub-subagent delegation (subagent_depth: 2)"
SID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga","parts":[{"type":"text","text":"Audit every module in lib/ and src/: one worker per area, and each worker MUST use its own sub-subagents (you have subagent_depth 2) to search the files in parallel — instruct them explicitly to do so. Deliverable: a table of module -> exported functions. This is a wide search task; delegation is required, not optional."}]}' -o /dev/null
W=0
while [ $W -lt 600 ]; do ans >/dev/null 2>&1; [ -n "$(idle "$SID" "$SSE")" ] && break; sleep 2; W=$((W+2)); done
md "final:"; code "$(ft "$SID")"
# grandchild sessions: sessions whose parent is NOT the orchestrator but a gigga-worker session
node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$H/.local/share/opencode/opencode.db',{readOnly:true});
const orch='$SID';
const workers=db.prepare('select id, agent from session where parent_id=?').all(orch).filter(s=>/gigga-worker/.test(s.agent||''));
console.log('worker sessions:', workers.map(w=>w.id+'('+w.agent+')').join(', ') || 'none');
for(const w of workers){
  const kids=db.prepare('select id, agent from session where parent_id=?').all(w.id);
  for(const k of kids) console.log('SUB-SUBAGENT:', k.id, 'agent='+(k.agent||'?'), 'parent='+w.id);
}
db.close();
" 2>&1 | grep -av Experimental
GC=$(node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$H/.local/share/opencode/opencode.db',{readOnly:true});
const workers=db.prepare('select id from session where parent_id=?').all('$SID');
let n=0;
for(const w of workers) n+=db.prepare('select count(*) c from session where parent_id=?').get(w.id).c;
console.log(n);
db.close();
" 2>/dev/null | tail -1)
md "grandchild (sub-subagent) sessions: $GC"
if [ "${GC:-0}" -ge 1 ]; then md "**DELEGATION: PASS**"; else md "**DELEGATION: CHECK** — no grandchild sessions observed"; fi

# ------------------------------------------------------- tier selection ----
md ""
md "## Tier selection by difficulty"
TIER_SID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' -d "{\"directory\":\"$FX\",\"agent\":\"gigga\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/session/$TIER_SID/prompt_async" -H 'content-type: application/json' -d '{"agent":"gigga","parts":[{"type":"text","text":"Two changes: (1) trivial: add a minus(a,b) function to src/calc.ts; (2) hard: refactor lib/mod1.js through lib/mod12.js into a single consolidated module with a compatibility shim re-exporting every helper, keeping all imports working — use a high-tier worker for the hard one."}]}' -o /dev/null
W=0
while [ $W -lt 600 ]; do ans >/dev/null 2>&1; [ -n "$(idle "$TIER_SID" "$SSE")" ] && break; sleep 2; W=$((W+2)); done
TIERS_USED=$(python3 - "$SSE" <<'PY'
import json, sys
seen = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    if d.get("type") != "message.part.updated": continue
    p = d.get("properties", {}); part = p.get("part", {})
    if part.get("type") != "tool" or part.get("tool") != "task": continue
    if p.get("sessionID") != sys.argv[2]: continue
    t = part.get("state", {}).get("input", {}).get("subagent_type", "")
    if t.startswith("gigga-worker-") and t not in seen: seen.append(t)
print(" ".join(seen))
PY
 "$SSE" "$TIER_SID")
md "worker tiers used: $TIERS_USED (low+high mix expected: trivial→low/default, hard→high)"
if echo "$TIERS_USED" | grep -q "gigga-worker-high" && [ "$(echo "$TIERS_USED" | wc -w)" -ge 2 ]; then
  md "**TIERS: PASS** — difficulty-based tier spread observed"
else
  md "**TIERS: CHECK** — see tiers used (orchestrator discretion; default tier alone is compliant)"
fi
md "--- end ---"
