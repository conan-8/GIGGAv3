#!/usr/bin/env bash
# Wizard-only E2E (gate 1): fresh sandbox, agent-driven setup, evidence to
# stdout. Answers ANY pending GIGGA question (wizard questions come from the
# GIGGA-config subagent's session, not the orchestrator's).
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT="${GIGGA_WIZ_PORT:-4475}"
BASE="http://127.0.0.1:$PORT"
SB="$(mktemp -d /tmp/GIGGA-wiz.XXXXXX)"
H="$SB/home"; SSE="$SB/sse.log"
md() { printf '%s\n' "$*"; }
code() { printf '```\n%s\n```\n' "$*"; }
trap 'bash "$REPO/test/stop_servers.sh" "$PORT" >/dev/null 2>&1' EXIT

md "# GIGGA setup-wizard E2E — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$H/.config" "$H/.local/share/opencode"
GIGGA_HOME="$H/.config/opencode" GIGGA_SRC="$REPO" bash "$REPO/install.sh" >/dev/null
cp ~/.local/share/opencode/auth.json "$H/.local/share/opencode/auth.json" 2>/dev/null || md "WARN: no auth"
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
git -C "$FX" init -q && git -C "$FX" add -A && git -C "$FX" -c user.email=w@t -c user.name=w commit -qm init
( cd "$FX" && HOME="$H" setsid nohup opencode serve --port "$PORT" > "$SB/serve.log" 2>&1 < /dev/null & )
for _ in $(seq 1 30); do curl -s -o /dev/null "$BASE/global/health" && break; sleep 1; done
: > "$SSE"; curl -sN "$BASE/event" >> "$SSE" &
sleep 2

MODEL=$(HOME=$H opencode models 2>/dev/null | grep '^kimi-for-coding/' | head -1)
[ -n "$MODEL" ] || MODEL=$(HOME=$H opencode models 2>/dev/null | grep '/' | head -1)
md "sandbox model: $MODEL"
CFG="$H/.config/opencode/GIGGA/GIGGA.config.json"
AG="$H/.config/opencode/agents"

W_SID=$(curl -s -X POST "$BASE/session" -H 'content-type: application/json' \
  -d "{\"directory\":\"$FX\",\"agent\":\"GIGGA\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
md "session: $W_SID"
curl -s -X POST "$BASE/session/$W_SID/prompt_async" -H 'content-type: application/json' \
  -d '{"agent":"GIGGA","parts":[{"type":"text","text":"Set up GIGGA now — run the setup wizard with me."}]}' -o /dev/null

# answer ANY pending question from any GIGGA session (wizard asks from its subagent session)
answer_any() {
  local line rid labels label
  line=$(python3 - "$SSE" <<'PY'
import json, sys
replied, pending = set(), []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    t, p = d.get("type"), d.get("properties", {})
    if t in ("question.replied", "question.rejected"): replied.add(p.get("requestID"))
    elif t == "question.asked":
        sid = p.get("sessionID", "")
        labels = [o.get("label", "") for q in p.get("questions", []) for o in q.get("options", [])]
        pending.append((p.get("id"), labels, p.get("questions", [{}])[0].get("question", "")[:80]))
for rid, labels, q in pending:
    if rid not in replied:
        print(rid + "|" + ";".join(labels) + "|" + q); break
PY
)
  [ -z "$line" ] && return 1
  rid=$(echo "$line" | cut -d'|' -f1); labels=$(echo "$line" | cut -d'|' -f2); q=$(echo "$line" | cut -d'|' -f3-)
  label=$(python3 -c '
import sys
labels = [l for l in sys.argv[1].split(";") if l]
prefer = sys.argv[2]; qtext = sys.argv[3].lower()
pick = labels[0] if labels else "yes"
if "confirm" in qtext or "step 6" in qtext:
    for l in labels:
        if any(w in l.lower() for w in ("confirm","yes","save","ok","apply","looks good","write")): pick = l; break
else:
    for l in labels:
        if prefer in l.lower(): pick = l; break
print(pick)
' "$labels" "${WIZ_ANSWER:-kimi}" "$q")
  curl -s -X POST "$BASE/question/$rid/reply" -H 'content-type: application/json' \
    -d "{\"answers\":[[\"$label\"]]}" -o /dev/null
  echo "Q: $q -> answered: $label"
}

WIZ_ANSWER=kimi
W_LOG="$SB/w.log"
(
  n=0
  while [ "$n" -lt 14 ]; do
    r=$(answer_any) && { echo "$r"; n=$((n+1)); }
    [ "$n" -ge 2 ] && WIZ_ANSWER=medium
    [ "$n" -ge 3 ] && WIZ_ANSWER=first
    st=$(python3 - "$SSE" <<'PY'
import json, sys
status = None
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    if d.get("type") == "session.status": status = d.get("properties", {}).get("status", {}).get("type")
print(status or "")
PY
)
    [ "$st" = "idle" ] && sleep 4 && break
    sleep 2
  done
) > "$W_LOG" 2>&1 &
WMON=$!
for _ in $(seq 1 300); do
  st=$(python3 - "$SSE" <<'PY'
import json, sys
status = None
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data: "): continue
    try: d = json.loads(line[6:])
    except Exception: continue
    if d.get("type") == "session.status": status = d.get("properties", {}).get("status", {}).get("type")
print(status or "")
PY
)
  [ "$st" = "idle" ] && python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if c.get("configured") else 1)' "$CFG" 2>/dev/null && break
  sleep 2
done
sleep 4; kill $WMON 2>/dev/null
md "wizard Q&A log:"; code "$(cat "$W_LOG")"

final_text() {
  node --no-warnings -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('$H/.local/share/opencode/opencode.db',{readOnly:true});
const msgs=db.prepare('select id, data from message where session_id=? order by time_created').all('$W_SID');
const parts=db.prepare('select message_id, data from part where session_id=? order by time_created').all('$W_SID');
const by=new Map();
for(const p of parts){ if(!by.has(p.message_id)) by.set(p.message_id,[]); by.get(p.message_id).push(typeof p.data==='string'?JSON.parse(p.data):p.data); }
const texts=[];
for(const m of msgs){
  const d=typeof m.data==='string'?JSON.parse(m.data):m.data;
  if(d.role!=='assistant') continue;
  for(const p of (by.get(m.id)??[])) if(p.type==='text'&&p.text?.trim()) texts.push(p.text);
}
console.log(texts.at(-1) ?? '(none)');
db.close();
"
}
md "orchestrator final:"; code "$(final_text)"
md "config after:"; code "$(cat "$CFG")"
md "agent model lines:"; code "$(grep -H '^model:' "$AG"/GIGGA-worker-*.md "$AG/GIGGA.md")"
if python3 -c '
import json, sys
c = json.load(open(sys.argv[1]))
ok = c.get("configured") and all(not v.startswith("anthropic/claude-") for v in c["tiers"].values())
sys.exit(0 if ok else 1)' "$CFG" \
   && grep -q "set by GIGGA-config" "$AG/GIGGA-worker-low.md" \
   && ! grep -q "model: anthropic/claude-haiku" "$AG/GIGGA-worker-low.md"; then
  md "**WIZARD: PASS** — guided setup wrote config + agent files"
else
  md "**WIZARD: CHECK/FAIL** — inspect above"
fi
