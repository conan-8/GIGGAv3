// GIGGA dashboard frontend — vanilla ES module, no build step.

const $ = (sel) => document.querySelector(sel)

const PHASE_TO_STEP = {
  idle: -1, recon: 0, questions: 1, plan: 2, executing: 3, checking: 4, done: 5,
  failed: 4,
}

let current = { state: null, server: null, configExists: true }
let activeAgentKey = null // "orchestrator" | "worker:3" | "recon" | ...
let lastPendingQuestion = false
let audioCtx = null
let fasttrackArmed = false
let lastRenderSig = null

// ------------------------------------------------------------ utilities ---
function agentKey(a, fallback) {
  if (a.kind === "orchestrator") return "orchestrator"
  if (a.kind === "worker") return `worker:${a.id}`
  return a.kind
}
function findAgent(state, key) {
  if (!state?.agents) return null
  if (key === "orchestrator") return state.agents.find((a) => a.kind === "orchestrator")
  if (key.startsWith("worker:")) {
    const id = Number(key.split(":")[1])
    return state.agents.find((a) => a.kind === "worker" && a.id === id)
  }
  return state.agents.find((a) => a.kind === key)
}

// ---------------------------------------------------------------- audio ----
function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch {}
  }
  audioCtx?.resume?.()
}
window.addEventListener("pointerdown", unlockAudio, { once: true })

async function beep() {
  if (!current.configSound) return
  if (!audioCtx) return
  try {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.frequency.value = 880
    osc.type = "sine"
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15)
    osc.connect(gain).connect(audioCtx.destination)
    osc.start()
    osc.stop(audioCtx.currentTime + 0.15)
  } catch {}
}

// ---------------------------------------------------------------- state ----
async function fetchState() {
  try {
    const r = await fetch("/api/state")
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    current.server = d.server
    current.configExists = d.configExists
    applyState(d.state)
  } catch (e) {
    $("#server-note").textContent = `state fetch failed: ${e}`
  }
}

function applyState(state) {
  const prevPending = current.state?.pendingQuestion
  // skip DOM churn when neither the state nor the selection changed — the
  // periodic fetch would otherwise rebuild boxes mid-click
  const sig = JSON.stringify({ s: state, k: activeAgentKey, h: location.hash, ce: current.configExists, r: current.server?.reachable })
  if (sig === lastRenderSig) return
  lastRenderSig = sig
  current.state = state
  const phase = state?.phase ?? "idle"
  const agents = state?.agents ?? []

  // config sound flag (fetch lazily once)
  if (current.configSound === undefined) {
    fetch("/api/config").then((r) => r.json()).then((d) => {
      current.configSound = d.config?.sound !== false
    }).catch(() => { current.configSound = true })
  }

  // stepper
  const idx = PHASE_TO_STEP[phase] ?? -1
  document.querySelectorAll(".step").forEach((el, i) => {
    el.classList.toggle("current", i === idx)
    el.classList.toggle("done", i < idx)
  })
  $("#bar-fill").style.width = `${Math.round(((idx + 1) / 6) * 100)}%`

  // orchestrator box
  const orch = agents.find((a) => a.kind === "orchestrator")
  const orchBox = $("#box-orchestrator")
  if (orch) {
    orchBox.style.display = ""
    orchBox.classList.toggle("working", orch.status === "working")
    orchBox.classList.toggle("active", activeAgentKey === "orchestrator")
  } else {
    orchBox.style.display = "none"
  }

  // worker + recon/checker/fasttrack boxes
  const wrap = $("#worker-boxes")
  wrap.innerHTML = ""
  for (const a of agents.filter((x) => x.kind !== "orchestrator")) {
    const box = document.createElement("div")
    box.className = "agent-box"
    const key = agentKey(a)
    box.dataset.agent = key
    box.tabIndex = 0
    const label = a.kind === "worker" ? `#${a.id}` : a.kind.toUpperCase()
    const tier = a.tier ? a.tier.toUpperCase() : ""
    const tierClass = a.tier === "low" ? "L" : a.tier === "medium" ? "M" : a.tier === "high" ? "H" : ""
    box.innerHTML = `
      <div class="head">
        <span class="num">${label}</span>
        <span>
          ${tier ? `<span class="badge tier-${tierClass}">${tier}</span>` : ""}
          <span class="badge status-${a.status}">${a.status}</span>
        </span>
      </div>
      <div class="task">${escapeHtml(a.task || "")}</div>`
    if (a.status === "working") box.classList.add("working")
    if (activeAgentKey === key) box.classList.add("active")
    box.addEventListener("click", () => selectAgent(key))
    wrap.appendChild(box)
  }

  // red ring + beep
  const pending = !!state?.pendingQuestion
  $("#red-ring").hidden = !pending
  if (pending && !prevPending && prevPending !== undefined) beep()
  if (pending && !lastPendingQuestion) beep()
  lastPendingQuestion = pending

  // views
  const hasRun = agents.length > 0
  const showConfig = location.hash === "#config" || (!current.configExists && !hasRun)
  $("#config-view").hidden = !showConfig
  if (showConfig) {
    $("#empty-state").hidden = true
    $("#agent-view").hidden = true
  } else if (hasRun) {
    $("#empty-state").hidden = true
    $("#agent-view").hidden = activeAgentKey === null
    if (activeAgentKey !== null) renderActiveAgent()
  } else {
    $("#empty-state").hidden = false
    $("#agent-view").hidden = true
  }

  // server note
  const s = current.server
  $("#server-note").textContent = s?.reachable
    ? `opencode server: ${s.url}`
    : "opencode server unreachable — status-only mode (state file + disk)"
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

// --------------------------------------------------------- agent viewing ---
function selectAgent(key) {
  activeAgentKey = key
  location.hash = ""
  applyState(current.state)
  renderActiveAgent()
}

async function renderActiveAgent() {
  const a = findAgent(current.state, activeAgentKey)
  if (!a) return
  const title = a.kind === "worker" ? `worker #${a.id}` : a.kind
  $("#agent-view-title").textContent = title
  const st = $("#agent-view-status")
  st.textContent = a.status
  st.className = a.status

  const sid = a.sessionId
  const msgsEl = $("#messages")
  if (!sid) {
    msgsEl.innerHTML = `<div class="dim">No session id yet — ${escapeHtml(a.status)}…</div>`
    return
  }
  try {
    const r = await fetch(`/api/session/${sid}/messages`)
    const d = await r.json()
    if (d.source === "unavailable") {
      msgsEl.innerHTML = `<div class="dim">${escapeHtml(d.note)}</div>`
      return
    }
    msgsEl.innerHTML = ""
    for (const m of d.messages ?? []) {
      const role = m.info?.role ?? "?"
      const div = document.createElement("div")
      div.className = `msg ${role}`
      const parts = []
      for (const p of m.parts ?? []) {
        if (p.type === "text" && p.text?.trim()) parts.push(escapeHtml(p.text))
        else if (p.type === "reasoning" && p.text?.trim()) parts.push(`<span class="dim">// ${escapeHtml(p.text)}</span>`)
        else if (p.type === "tool") parts.push(`<span class="tool-line"><b>${escapeHtml(p.tool)}</b> ${escapeHtml(p.state?.status ?? "")}</span>`)
      }
      div.innerHTML = `<div class="role">${role.toUpperCase()}</div><div class="body">${parts.join("\n") || "<span class='dim'>(no text)</span>"}</div>`
      msgsEl.appendChild(div)
    }
    msgsEl.scrollTop = msgsEl.scrollHeight
  } catch (e) {
    msgsEl.innerHTML = `<div class="dim">messages unavailable: ${escapeHtml(String(e))}</div>`
  }
}

// poll the active agent's messages while it is working
setInterval(() => {
  if (activeAgentKey && !$("#agent-view").hidden) renderActiveAgent()
}, 2000)

// ------------------------------------------------------------- fasttrack ---
$("#fasttrack-btn").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/fasttrack", { method: "POST" })
    const d = await r.json()
    if (d.ok) {
      fasttrackArmed = true
      const btn = $("#fasttrack-btn")
      btn.classList.add("armed")
      btn.textContent = "✓ FASTTRACK ARMED"
      setTimeout(() => {
        btn.classList.remove("armed")
        btn.textContent = "⚡ FASTTRACK"
      }, 6000)
    }
  } catch {}
})

// ---------------------------------------------------------------- config ---
async function loadConfigScreen() {
  try {
    const r = await fetch("/api/config")
    const d = await r.json()
    const form = $("#config-form")
    const cfg = d.config ?? d.defaults ?? {}
    for (const sel of form.querySelectorAll("select[name=low],select[name=medium],select[name=high]")) {
      sel.innerHTML = (d.models?.length ? d.models : [cfg.tiers?.[sel.name]].filter(Boolean))
        .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
        .join("")
      if (cfg.tiers?.[sel.name]) sel.value = cfg.tiers[sel.name]
    }
    form.defaultTier.value = cfg.defaultTier ?? "medium"
    form.maxParallel.value = cfg.maxParallel ?? 5
    form.autoRetry.checked = !!cfg.autoRetry
    form.sound.checked = cfg.sound !== false
    form.questionRounds.value = cfg.questionRounds ?? 2
    if (!d.models?.length) {
      $("#config-msg").className = ""
      $("#config-msg").textContent = "model list unavailable — using current values"
    }
  } catch (e) {
    $("#config-msg").className = "err"
    $("#config-msg").textContent = `config load failed: ${e}`
  }
}

$("#config-form").addEventListener("submit", async (ev) => {
  ev.preventDefault()
  const f = ev.target
  const body = {
    tiers: { low: f.low.value, medium: f.medium.value, high: f.high.value },
    defaultTier: f.defaultTier.value,
    maxParallel: Number(f.maxParallel.value),
    autoRetry: f.autoRetry.checked,
    sound: f.sound.checked,
    questionRounds: Number(f.questionRounds.value),
  }
  const msg = $("#config-msg")
  msg.className = ""
  msg.textContent = "saving…"
  try {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const d = await r.json()
    if (r.ok && d.ok) {
      msg.className = "ok"
      msg.textContent = "saved ✓ (agent model lines updated; restart opencode sessions to apply)"
      current.configExists = true
      current.configSound = body.sound
    } else {
      msg.className = "err"
      msg.textContent = (d.errors ?? ["unknown error"]).join("; ")
    }
  } catch (e) {
    msg.className = "err"
    msg.textContent = String(e)
  }
})

$("#config-link").addEventListener("click", (e) => {
  e.preventDefault()
  location.hash = "#config"
  applyState(current.state)
  loadConfigScreen()
})
window.addEventListener("hashchange", () => {
  if (location.hash === "#config") loadConfigScreen()
  applyState(current.state)
})

// ------------------------------------------------------------------ boot ---
const es = new EventSource("/api/events")
es.addEventListener("state", (ev) => {
  try { applyState(ev.data ? JSON.parse(ev.data) : null) } catch {}
})
es.onerror = () => { $("#server-note").textContent = "live stream reconnecting…" }
fetchState()
setInterval(fetchState, 3000) // belt and braces alongside SSE
if (location.hash === "#config") loadConfigScreen()
