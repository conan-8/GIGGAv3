import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"

/**
 * GIGGA plugin — orchestration state tracker (session 4).
 *
 * Maintains PER-PROJECT state under
 *   <cfgRoot>/GIGGA/projects/<slug>-<hash10>/state.json
 * (cfgRoot = GIGGA_HOME or ~/.config/opencode; slug+hash derive from the
 * project/worktree dir — see projectStatePath, mirrored in
 * dashboard/lib/shared.mjs and plugin/GIGGA-sidebar.tsx with a conformance
 * test in dashboard/test/session4.test.mjs).
 *
 * Also: server discovery (server.json), stale-run recovery on load,
 * pending-question signaling (bell + toast), phase-transition toasts, and a
 * question-round cap enforced via tool.execute.before (args mutation).
 *
 * Verified behaviors (opencode 1.18.18 — DEVIATIONS.md):
 * - the plugin may be instantiated more than once → all state on disk,
 *   atomic tmp+rename per instance, mkdir-lock serialization;
 * - question.asked/replied, task tool part updates, session.idle/error shapes;
 * - permission.ask hook does NOT fire for the question tool → the cap is
 *   enforced by emptying the question args at the (cap+1)-th call.
 * - every handler wrapped: plugin errors never crash opencode.
 */

function projectStatePath(projectDir: string, cfgRoot: string): string {
  const slug = basename(projectDir).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "project"
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 10)
  return join(cfgRoot, "GIGGA", "projects", `${slug}-${hash}`, "state.json")
}

const CFG_ROOT = process.env.GIGGA_HOME ?? join(process.env.HOME ?? "~", ".config", "opencode")
const GIGGA_DIR = join(CFG_ROOT, "GIGGA")
const CONFIG_FILE = join(GIGGA_DIR, "GIGGA.config.json")
const SERVER_FILE = join(GIGGA_DIR, "server.json")
const LAST_MODEL_FILE = join(GIGGA_DIR, "last-model.json")
const STALE_AFTER_MS = 120_000

// per-project paths — set at plugin init
let STATE_FILE = join(GIGGA_DIR, "state.json")
let STATE_TMP = `${STATE_FILE}.tmp`
let STATE_DIR = GIGGA_DIR
let EVENTS_LOG = join(GIGGA_DIR, "events.log")
let LOCK_DIR = join(GIGGA_DIR, ".lock")

type Phase =
  | "idle"
  | "recon"
  | "questions"
  | "plan"
  | "executing"
  | "checking"
  | "done"
  | "failed"
type Kind = "orchestrator" | "worker" | "recon" | "checker" | "fasttrack"
type Tier = "low" | "medium" | "high" | null

interface AgentEntry {
  id: number
  kind: Kind
  tier: Tier
  task: string
  status: "working" | "done" | "failed"
  sessionId: string | null
  parentSessionId: string
  startedAt?: string
  endedAt?: string
}

interface RunState {
  phase: Phase
  pendingQuestion: boolean
  originalRequest: string
  agents: AgentEntry[]
  updatedAt: string
  orchestrator: string | null
  workerCounter: number
  taskCalls: Record<string, { entryIndex: number; asked: boolean }>
  sessions: Record<string, { agent?: string; parent?: string; firstUserText?: string; createdAt?: string }>
  answeredQuestions: Record<string, boolean>
  questionCalls: Record<string, number>
  retries: number
  runStartedAt?: string
  doneAt?: string
  failReason?: "error" | "interrupted"
  recordedAt?: string
}

const freshState = (): RunState => ({
  phase: "idle",
  pendingQuestion: false,
  originalRequest: "",
  agents: [],
  updatedAt: new Date().toISOString(),
  orchestrator: null,
  workerCounter: 0,
  taskCalls: {},
  sessions: {},
  answeredQuestions: {},
  questionCalls: {},
  retries: 0,
  runStartedAt: undefined,
  doneAt: undefined,
  failReason: undefined,
  recordedAt: undefined,
})

let serverUrl: URL | null = null
// In plain TUI mode opencode listens on NO port — serverUrl points at the
// default http://localhost:4096/ with nothing behind it (DEVIATIONS #29).
// Probed once at load; when unreachable the title sidebar + HTTP toasts are
// skipped (plugins/GIGGA-sidebar.tsx renders progress + notifications
// in-TUI instead). Title PATCHes still work when attached to `opencode serve`.
let serverReachable = false

async function probeServer(): Promise<boolean> {
  if (!serverUrl) return false
  try {
    const r = await fetch(new URL("global/health", serverUrl), { signal: AbortSignal.timeout(1000) })
    return r.ok
  } catch {
    return false
  }
}

async function log(line: string) {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await appendFile(EVENTS_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function readConfig(): any {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  } catch {
    return {}
  }
}

// The prompt-time model, recorded from chat.params so first-run auto-config
// and /GIGGA-setup can default all tiers to the model the user is actually
// using. GIGGA's own sessions are skipped: post-config they run on tier
// models, which are NOT the user's selection. Model selection in the TUI is
// global, so the last non-GIGGA selection is effectively the current one.
let lastRecordedModel = ""
async function recordLastModel(id: string) {
  if (!id || id === lastRecordedModel) return
  lastRecordedModel = id
  try {
    await mkdir(GIGGA_DIR, { recursive: true })
    await writeFile(LAST_MODEL_FILE, JSON.stringify({ model: id, updatedAt: new Date().toISOString() }, null, 2) + "\n")
  } catch {}
}

async function readState(): Promise<RunState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"))
    return { ...freshState(), ...raw }
  } catch {
    return freshState()
  }
}

async function writeState(s: RunState) {
  s.updatedAt = new Date().toISOString()
  await mkdir(STATE_DIR, { recursive: true })
  const pub = {
    phase: s.phase,
    pendingQuestion: s.pendingQuestion,
    originalRequest: s.originalRequest,
    agents: s.agents,
    updatedAt: s.updatedAt,
  }
  const full = {
    ...pub,
    orchestrator: s.orchestrator,
    workerCounter: s.workerCounter,
    taskCalls: s.taskCalls,
    sessions: s.sessions,
    answeredQuestions: s.answeredQuestions,
    questionCalls: s.questionCalls,
    retries: s.retries,
    runStartedAt: s.runStartedAt,
    doneAt: s.doneAt,
    failReason: s.failReason,
    recordedAt: s.recordedAt,
  }
  const tmp = `${STATE_TMP}.${process.pid}.${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  await writeFile(tmp, JSON.stringify(full, null, 2) + "\n")
  await rename(tmp, STATE_FILE)
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(STATE_DIR, { recursive: true })
  for (let i = 0; ; i++) {
    try {
      await mkdir(LOCK_DIR)
      break
    } catch {
      let age = 0
      try {
        age = Date.now() - (await stat(LOCK_DIR)).mtimeMs
      } catch {
        break
      }
      if (age > 5000) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (i > 200) return fn()
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {})
  }
}

async function update(mutate: (s: RunState) => boolean): Promise<boolean> {
  return withLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const s = await readState()
        if (!mutate(s)) return false
        await writeState(s)
        return true
      } catch (e) {
        if (attempt === 2) {
          await log(`state update failed: ${String(e)}`)
          return false
        }
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20))
      }
    }
    return false
  })
}

async function bell() {
  if (readConfig().sound === false) {
    await log("bell: skipped (config sound=false)")
    return
  }
  try {
    await appendFile("/dev/tty", "\x07")
    await log("bell: sent \\x07 to /dev/tty")
  } catch {
    await log("bell: /dev/tty unavailable (headless server) — skipped")
  }
}

async function toast(message: string, variant: "info" | "warning" | "error" | "success") {
  if (!serverUrl || !serverReachable) return
  try {
    const res = await fetch(new URL("tui/show-toast", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, variant, title: "GIGGA", duration: 6000 }),
    })
    if (!res.ok) await log(`toast: HTTP ${res.status}`)
  } catch (e) {
    await log(`toast failed: ${String(e)}`)
  }
}

// TUI sidebar integration (verified opencode 1.18.18, DEVIATIONS #27): the
// sidebar (ctrl+x b) lists sessions by title, and titles are live-updatable —
// but ONLY when an opencode HTTP server is reachable (serve/attach mode; in
// plain TUI mode nothing listens, see DEVIATIONS #29, and the GIGGA-sidebar
// TUI slot plugin renders the same progress in the sidebar instead).
async function setTitle(sessionID: string | null | undefined, title: string): Promise<boolean> {
  if (!serverUrl || !serverReachable || !sessionID) return false
  try {
    const res = await fetch(new URL(`session/${sessionID}`, serverUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: Array.from(title).slice(0, 70).join("") }), // split by code point — never cut an emoji
    })
    if (!res.ok) {
      await log(`setTitle: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    await log(`setTitle failed: ${String(e)}`)
    return false
  }
}

const shortTask = (s: string, max = 40) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max)

// ------------------------------------------------ TUI sidebar tree render --
// The TUI sidebar cannot render widgets, but every session row's TITLE is
// live-updatable. GIGGA renders an animated tree (pure-title format):
// - orchestrator row: 6-step phase bar with a pulsing current step, plus one
//   traffic-light dot per subagent (🟢 done · ❌ failed · 🟡 running · 🔴
//   spawning), re-sorted live;
// - child rows: `├─`/`└─` connector, status dot, braille spinner while
//   running, and for workers a time-budget bar (elapsed vs tier budget
//   H 20m · M 10m · L 5m) with a ticking m:ss clock; frozen as
//   `✓ m:ss` / `✗ m:ss` when finished. Dots are emoji so they keep their
//   native red/yellow/green in the plain-text title.
// A 1s sweep PATCHes all rows in one pass; spinner phase, step pulse and the
// done-flash derive from wall-clock time, so concurrent plugin instances
// compute identical titles (no flapping).
// EXPORT SHAPE (verified opencode 1.18.18, DEVIATIONS #28): the plugin loader
// calls EVERY module export as a plugin — this file must export exactly one
// function (`GiggaPlugin`). A non-function export throws "Plugin export is
// not a function"; a helper that touches its args throws when invoked with
// the PluginInput object (path.basename → "path property must be of type
// string, got object"). Keep helpers module-private.
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const PHASE_STEPS: Record<string, number> = {
  idle: 0, recon: 1, questions: 2, plan: 3, executing: 4, checking: 5, done: 6, failed: 4,
}
const PHASE_WORD: Record<string, string> = {
  recon: "RECON", questions: "QUESTIONS", plan: "PLAN", executing: "EXECUTE", checking: "CHECK",
}
const TIER_BUDGET_MS: Record<string, number> = { high: 20 * 60_000, medium: 10 * 60_000, low: 5 * 60_000 }

function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`
}

function elapsedMs(a: AgentEntry): number | null {
  if (!a.startedAt) return null
  const d = (a.endedAt ? Date.parse(a.endedAt) : Date.now()) - Date.parse(a.startedAt)
  return isFinite(d) ? Math.max(0, d) : null
}

function dotOf(a: AgentEntry): string {
  if (a.status === "done") return "🟢"
  if (a.status === "failed") return "❌"
  return a.sessionId ? "🟡" : "🔴"
}

const dotRank = (a: AgentEntry) => (a.status === "done" ? 0 : a.status === "failed" ? 1 : a.sessionId ? 2 : 3)

function orchBar(phase: string, sec: number): string {
  const step = PHASE_STEPS[phase] ?? 0
  if (phase === "done") return "▓".repeat(6)
  if (phase === "failed" || step === 0) return "▓".repeat(step) + "░".repeat(6 - step)
  return "▓".repeat(step - 1) + (sec % 2 ? "▒" : "▓") + "░".repeat(6 - step)
}

function budgetBar(a: { tier: Tier }, ms: number): string {
  const budget = a.tier ? TIER_BUDGET_MS[a.tier] : undefined
  if (!budget) return ""
  const cells = Math.max(1, Math.min(5, Math.ceil((ms / budget) * 5)))
  return "▓".repeat(cells) + "░".repeat(5 - cells)
}

function orchestratorTitle(s: RunState, sec: number, flash = false): string {
  if (s.phase === "failed") {
    return s.failReason === "interrupted" ? "✗ GIGGA ▓▓▓▓░░ interrupted" : "✗ GIGGA ▓▓▓▓░░ failed — /GIGGA-retry"
  }
  if (s.phase === "done") {
    const ws = s.agents.filter((a) => a.kind === "worker")
    const dur = s.runStartedAt && s.doneAt ? ` · ${fmtClock(Date.parse(s.doneAt) - Date.parse(s.runStartedAt))}` : ""
    const wsSuffix = ws.length ? ` · ${ws.length} worker${ws.length === 1 ? "" : "s"}` : ""
    return `${flash ? "🎉" : "✓"} GIGGA ▓▓▓▓▓▓ done${dur}${wsSuffix}`
  }
  const dots = s.agents
    .filter((a) => a.kind !== "orchestrator")
    .sort((x, y) => dotRank(x) - dotRank(y))
    .slice(0, 10)
    .map(dotOf)
    .join("")
  const word = s.phase === "questions" && s.pendingQuestion ? "QUESTIONS — waiting for you" : s.phase === "idle" ? "WORKING" : PHASE_WORD[s.phase] ?? s.phase.toUpperCase()
  return dots ? `⚡ GIGGA ${orchBar(s.phase, sec)} · ${dots} ${word}` : `⚡ GIGGA ${orchBar(s.phase, sec)} ${word}`
}

function childTitle(s: RunState, a: AgentEntry, idx: number, isLast: boolean, sec: number): string {
  const conn = isLast ? "└─" : "├─"
  const name = a.kind === "worker" ? `#${a.id} ${shortTask(a.task, 22)}` : `${a.kind} ${shortTask(a.task, 18)}`
  if (a.status !== "working") {
    const clock = elapsedMs(a)
    return `${conn} ${dotOf(a)} ${name} ${a.status === "done" ? "✓" : "✗"}${clock != null ? ` ${fmtClock(clock)}` : ""}${a.status === "failed" && s.retries > 0 ? " · retry" : ""}`
  }
  const spin = SPINNER[(sec + idx) % SPINNER.length]
  const ms = elapsedMs(a)
  if (a.kind === "worker" && a.tier && ms != null) return `${conn} 🟡 ${name} ${spin} ${budgetBar(a, ms)} ${fmtClock(ms)}`
  return `${conn} 🟡 ${name} ${spin}${ms != null ? ` · ${fmtClock(ms)}` : ""}`
}

async function renderSidebar(s: RunState, flash = false) {
  if (!s.orchestrator || !serverUrl) return
  const sec = Math.floor(Date.now() / 1000)
  const rows = s.agents.filter((a) => a.kind !== "orchestrator" && a.sessionId)
  await Promise.all([
    patchTitle(s.orchestrator, orchestratorTitle(s, sec, flash)),
    ...rows.map((a, i) => patchTitle(a.sessionId!, childTitle(s, a, i, i === rows.length - 1, sec))),
  ])
}

// ---- 1s sweep: one batched pass over every row title; PATCHes only rows
// whose title changed since the last pass; renders finals and stops itself
// when the run is done/failed (the done state keeps ticking ~1.6s to flash
// 🎉 before settling to ✓).
let sweepTimer: ReturnType<typeof setInterval> | null = null
let lastSweepError = ""
const lastTitles = new Map<string, string>()

async function patchTitle(sessionID: string, title: string) {
  if (lastTitles.get(sessionID) === title) return
  if (await setTitle(sessionID, title)) lastTitles.set(sessionID, title) // cache only on success — failures retry next tick
}

function stopSweep() {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  lastTitles.clear()
}

async function sweepTick(pre?: RunState) {
  const s = pre ?? (await readState())
  if (!s.orchestrator) return stopSweep()
  if (s.phase === "failed") {
    await renderSidebar(s)
    return stopSweep()
  }
  if (s.phase === "done") {
    const flash = !!(s.doneAt && Date.now() - Date.parse(s.doneAt) < 1600)
    await renderSidebar(s, flash)
    if (!flash) stopSweep()
    return
  }
  await renderSidebar(s)
}

// Render now and keep the sweep alive while the run is active.
async function refreshSidebar(s?: RunState) {
  if (!serverUrl || !serverReachable) return
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      sweepTick().catch(async (e) => {
        const msg = `sweep failed: ${String(e)}`
        if (msg !== lastSweepError) {
          lastSweepError = msg
          await log(msg)
        }
      })
    }, 1000)
  }
  await sweepTick(s ?? (await readState()))
}

function classify(subagentType: string): { kind: Kind; tier: Tier } | null {
  if (subagentType === "GIGGA-recon") return { kind: "recon", tier: null }
  if (subagentType === "GIGGA-checker") return { kind: "checker", tier: null }
  if (subagentType === "GIGGA-fasttrack") return { kind: "fasttrack", tier: null }
  const m = /^GIGGA-worker-(low|medium|high)$/.exec(subagentType)
  if (m) return { kind: "worker", tier: m[1] as Tier }
  return null
}

function isGiggaSession(s: RunState, sessionID: string | undefined): boolean {
  if (!sessionID) return false
  if (sessionID === s.orchestrator) return true
  const info = s.sessions[sessionID]
  if (info?.agent?.toLowerCase().startsWith("GIGGA")) return true
  if (info?.parent && info.parent === s.orchestrator) return true
  return false
}

// ------------------------------------------------------------- recovery ----
async function recoverStale() {
  const acted = await update((s) => {
    const age = Date.now() - Date.parse(s.updatedAt || "0")
    if (!isFinite(age) || age < STALE_AFTER_MS) return false
    let changed = false
    const now = new Date().toISOString()
    for (const a of s.agents) {
      if (a.status === "working") {
        a.status = "failed"
        a.endedAt = now
        a.task = `${a.task} [failed (interrupted)]`.slice(0, 220)
        changed = true
      }
    }
    if (changed) {
      s.phase = "failed"
      s.failReason = "interrupted"
      s.doneAt = s.doneAt ?? now
      s.pendingQuestion = false
    }
    return changed
  })
  if (acted) {
    await log("recovered stale run: working agents marked failed (interrupted)")
    await recordRun(await readState())
    await refreshSidebar() // renders the ✗ final titles, then the sweep stops itself
  }
}

// ------------------------------------------- run history (self-improvement) -
// One JSON line per finished run in <project dir>/history.jsonl — objective
// metrics (durations, tier overruns, retries, checker rounds) the
// orchestrator reads at session start to plan better over time. Written at
// the terminal transitions only; state.recordedAt claims the write so
// duplicate events / multiple plugin instances record exactly once.
const HISTORY_FILE = () => join(STATE_DIR, "history.jsonl")

function buildRunRecord(s: RunState) {
  const end = s.doneAt ? Date.parse(s.doneAt) : Date.now()
  const start = s.runStartedAt ? Date.parse(s.runStartedAt) : end
  const agents = s.agents
    .filter((a) => a.kind !== "orchestrator")
    .map((a) => {
      const dur = elapsedMs(a)
      const budget = a.tier ? TIER_BUDGET_MS[a.tier] : undefined
      return {
        kind: a.kind,
        tier: a.tier ?? undefined,
        status: a.status,
        durationMs: dur ?? undefined,
        overBudget: budget != null && dur != null ? dur > budget : undefined,
      }
    })
  return {
    ts: new Date().toISOString(),
    phase: s.phase,
    failReason: s.failReason,
    request: shortTask(s.originalRequest, 120),
    durationMs: isFinite(end - start) ? Math.max(0, end - start) : undefined,
    retries: s.retries,
    checkerInvocations: s.agents.filter((a) => a.kind === "checker").length,
    agents,
  }
}

async function recordRun(s: RunState) {
  if (s.phase !== "done" && s.phase !== "failed") return
  const rec = buildRunRecord(s)
  const claimed = await update((st) => {
    if (st.recordedAt || (st.phase !== "done" && st.phase !== "failed")) return false
    st.recordedAt = new Date().toISOString()
    return true
  })
  if (!claimed) return
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await appendFile(HISTORY_FILE(), JSON.stringify(rec) + "\n")
    await log(`run recorded: ${rec.phase}${rec.failReason ? ` (${rec.failReason})` : ""} ${rec.durationMs ?? "?"}ms agents=${rec.agents.length} retries=${rec.retries}`)
  } catch (e) {
    await log(`run record failed: ${String(e)}`)
  }
}

// ------------------------------------------------------- phase toasts ------
let lastAnnouncedPhase: string | null = null
async function announcePhase(s: RunState) {
  if (s.phase === lastAnnouncedPhase) return
  const prev = lastAnnouncedPhase
  lastAnnouncedPhase = s.phase
  const workers = s.agents.filter((a) => a.kind === "worker")
  await refreshSidebar(s)
  switch (s.phase) {
    case "recon":
    case "questions":
      break
    case "plan":
      if (prev) await toast("GIGGA: planning…", "info")
      break
    case "executing": {
      const running = workers.filter((w) => w.status === "working").length
      const mp = Number(readConfig().maxParallel ?? 5)
      const free = Math.max(0, mp - running)
      await toast(`GIGGA: ${running} worker${running === 1 ? "" : "s"} running (${free} parallel slot${free === 1 ? "" : "s"} free)`, "info")
      break
    }
    case "checking":
      await toast("GIGGA: checking…", "info")
      break
    case "done":
      await toast("GIGGA: done", "success")
      break
    case "failed":
      await toast("GIGGA: failed / needs retry", "error")
      break
  }
}

// ---------------------------------------------------------------- plugin ---
export const GiggaPlugin: Plugin = async (input) => {
  serverUrl = input.serverUrl ?? null
  const projectDir = input.worktree || input.directory
  STATE_FILE = projectStatePath(projectDir, CFG_ROOT)
  STATE_DIR = dirname(STATE_FILE)
  STATE_TMP = `${STATE_FILE}.tmp`
  EVENTS_LOG = join(STATE_DIR, "events.log")
  LOCK_DIR = join(STATE_DIR, ".lock")
  await log(`plugin loaded (directory=${input.directory}, project=${projectDir})`)

  // server discovery for the dashboard
  try {
    await mkdir(GIGGA_DIR, { recursive: true })
    await writeFile(
      SERVER_FILE,
      JSON.stringify(
        {
          url: serverUrl?.href ?? null,
          directory: input.directory,
          worktree: input.worktree ?? null,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    )
  } catch {}

  serverReachable = await probeServer()
  if (!serverReachable) {
    await log("server unreachable (plain TUI mode hosts no HTTP listener — DEVIATIONS #29): title sidebar + HTTP toasts disabled; the GIGGA-sidebar TUI plugin renders progress in the sidebar instead")
  }

  // migrate legacy global state (sessions ≤3): rename it aside, never read
  try {
    const legacy = join(GIGGA_DIR, "state.json")
    await stat(legacy)
    await rename(legacy, `${legacy}.legacy-${Date.now()}`)
    await log("migrated legacy global state.json (renamed aside)")
  } catch {}

  await recoverStale()

  return {
    async event(input) {
      try {
        await handleEvent(input.event)
      } catch (e) {
        await log(`event handler error (${input.event?.type}): ${String(e)}`)
      }
    },
    async "chat.params"(input) {
      try {
        const agent = String(input.agent ?? "")
        if (agent.toLowerCase().startsWith("gigga")) return
        const m = input.model
        const id = m?.providerID && m?.id ? `${m.providerID}/${m.id}` : null
        if (id) await recordLastModel(id)
      } catch (e) {
        await log(`chat.params error: ${String(e)}`)
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool !== "question") return
        const cap = Number(readConfig().questionRounds ?? 2)
        const s = await readState()
        if (!isGiggaSession(s, input.sessionID)) return
        const calls = s.questionCalls[input.sessionID] ?? 0
        if (calls >= cap + 1) {
          output.args = { ...(output.args ?? {}), questions: [] }
          await log(`question cap enforced (session ${input.sessionID}: ${calls} calls ≥ cap ${cap}) — question emptied`)
          await toast("GIGGA: question round cap reached — proceeding with assumptions", "warning")
        }
      } catch (e) {
        await log(`tool.execute.before error: ${String(e)}`)
      }
    },
  }
}

async function handleEvent(ev: { type: string; properties?: any }) {
  const p = ev.properties ?? {}

  switch (ev.type) {
    case "session.created": {
      const info = p.info ?? {}
      let bound = false
      await update((s) => {
        const cur = s.sessions[info.id] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (info.parentID) next.parent = info.parentID
        if (!next.createdAt) next.createdAt = new Date().toISOString()
        if (JSON.stringify(cur) === JSON.stringify(next)) return false
        s.sessions[info.id] = next
        if (next.agent?.toLowerCase().startsWith("GIGGA") && next.parent) {
          const entry = s.agents.find(
            (a) => a.kind === classify(next.agent!)?.kind && a.status === "working" && a.sessionId === null,
          )
          if (entry) {
            entry.sessionId = info.id
            bound = true
          }
        }
        return true
      })
      if (bound) await refreshSidebar() // the child row exists now — title it immediately
      return
    }

    case "message.updated": {
      const info = p.info ?? {}
      const sid = p.sessionID as string | undefined
      if (!sid) return
      let firstUserText: string | undefined
      if (info.role === "user") {
        const parts = p.parts ?? info.parts ?? []
        const text = parts.find((x: any) => x?.type === "text")?.text
        if (typeof text === "string" && text.trim()) firstUserText = text.trim().slice(0, 500)
      }
      let orchTitle: string | null = null
      let bindOrchestrator = false
      await update((s) => {
        const cur = s.sessions[sid] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (!next.createdAt) next.createdAt = new Date().toISOString()
        if (firstUserText && !next.firstUserText) next.firstUserText = firstUserText
        let changed = false
        if (JSON.stringify(cur) !== JSON.stringify(next)) {
          s.sessions[sid] = next
          changed = true
        }
        // New activity in a finished run's session = a fresh run: reset so
        // the previous run's agents/progress don't carry over into the new
        // one (sidebar + dashboard). The >3s guard keeps a late-arriving
        // update of the run's final message from wiping the just-set state.
        if (
          sid === s.orchestrator &&
          (s.phase === "done" || s.phase === "failed") &&
          s.doneAt &&
          Date.now() - Date.parse(s.doneAt) > 3000
        ) {
          const sessions = s.sessions
          Object.assign(s, freshState())
          s.sessions = sessions
          s.orchestrator = sid
          s.runStartedAt = new Date().toISOString()
          bindOrchestrator = true
          changed = true
        }
        if (sid === s.orchestrator && !s.originalRequest && next.firstUserText) {
          s.originalRequest = next.firstUserText
          orchTitle = `⚡ GIGGA · ${shortTask(next.firstUserText)}`
          changed = true
        }
        // Bind a GIGGA primary session as the live run on its first activity,
        // even if it never spawns subagents (one-shot requests) — otherwise
        // the sidebar shows nothing at all for the whole run. NOTE: on
        // 1.18.18 message.updated carries no usable parts/role for extracting
        // the request text (DEVIATIONS #27), so the trigger is the session's
        // MAPPED agent (populated by session.created), not the message body.
        const agent = (next.agent ?? cur.agent ?? "").toLowerCase()
        if (
          agent.startsWith("gigga") &&
          s.orchestrator !== sid &&
          (!s.orchestrator || s.phase === "done" || s.phase === "failed" || s.phase === "idle")
        ) {
          const sessions = s.sessions
          Object.assign(s, freshState())
          s.sessions = sessions
          s.orchestrator = sid
          s.runStartedAt = new Date().toISOString()
          if (firstUserText) s.originalRequest = firstUserText
          bindOrchestrator = true
          changed = true
        }
        return changed
      })
      if (orchTitle) await setTitle(sid, orchTitle)
      if (bindOrchestrator) {
        await log(`orchestrator bound: ${sid} (agent=${(await readState()).sessions[sid]?.agent ?? "?"})`)
        await refreshSidebar() // starts the sweep — ⚡ row goes live immediately
      }
      return
    }

    case "question.asked": {
      const rid = p.id as string
      const acted = await update((s) => {
        if (!isGiggaSession(s, p.sessionID)) return false
        if (s.answeredQuestions[rid]) return false
        s.answeredQuestions[rid] = true
        s.questionCalls[p.sessionID] = (s.questionCalls[p.sessionID] ?? 0) + 1
        s.pendingQuestion = true
        if (["idle", "recon", "plan"].includes(s.phase)) s.phase = "questions"
        return true
      })
      if (!acted) return
      const q = p.questions?.[0]?.question ?? "(question)"
      await log(`question.asked [${rid}] ${String(q).slice(0, 120)}`)
      await refreshSidebar()
      await bell()
      await toast("GIGGA is waiting for your answer", "warning")
      return
    }

    case "question.replied":
    case "question.rejected": {
      const acted = await update((s) => {
        if (!s.pendingQuestion) return false
        s.pendingQuestion = false
        return true
      })
      if (acted) await log(`${ev.type} [${p.requestID ?? ""}]`)
      return
    }

    case "message.part.updated": {
      const part = p.part
      if (part?.type !== "tool") return
      if (part.tool === "todowrite") {
        const acted = await update((s) => {
          if (p.sessionID !== s.orchestrator) return false
          if (!["recon", "questions", "idle"].includes(s.phase)) return false
          s.phase = "plan"
          return true
        })
        if (acted) await announcePhase(await readState())
        return
      }
      if (part.tool !== "task") return

      const st = part.state ?? {}
      const subagentType = String(st.input?.subagent_type ?? "")
      const cls = classify(subagentType)
      if (!cls) return
      const callID = part.callID

      if (st.status === "running") {
        const acted = await update((s) => {
          if (s.taskCalls[callID]) return false
          const task = String(st.input?.description ?? st.input?.prompt ?? "").slice(0, 200)
          const dup = s.agents.some(
            (a) =>
              a.kind === cls.kind &&
              a.parentSessionId === p.sessionID &&
              a.task.slice(0, 60) === task.slice(0, 60),
          )
          if (dup) {
            s.taskCalls[callID] = { entryIndex: -1, asked: true }
            return false
          }
          const parent = p.sessionID
          if (s.orchestrator !== parent) {
            const fresh = freshState()
            Object.assign(s, fresh)
            s.orchestrator = parent
            s.runStartedAt = new Date().toISOString()
            s.agents.push({
              id: 0,
              kind: "orchestrator",
              tier: null,
              task: "orchestration",
              status: "working",
              sessionId: parent,
              parentSessionId: "",
            })
          }
          const entry: AgentEntry = {
            id: cls.kind === "worker" ? ++s.workerCounter : 0,
            kind: cls.kind,
            tier: cls.tier,
            task: String(st.input?.description ?? st.input?.prompt ?? "").slice(0, 200),
            status: "working",
            sessionId: null,
            parentSessionId: s.orchestrator!,
            startedAt: new Date().toISOString(),
          }
          s.agents.push(entry)
          s.taskCalls[callID] = { entryIndex: s.agents.length - 1, asked: true }
          if (cls.kind === "recon") s.phase = "recon"
          else if (cls.kind === "worker") s.phase = "executing"
          else if (cls.kind === "checker") s.phase = "checking"
          return true
        })
        if (acted) {
          await log(`task running [${callID}] ${subagentType} "${String(st.input?.description ?? "").slice(0, 60)}"`)
          const s2 = await readState()
          await refreshSidebar(s2) // explicit: announcePhase skips repeats across runs
          await announcePhase(s2)
        }
        return
      }

      if (st.status === "completed" || st.status === "error") {
        const m = /<task id="(ses_[A-Za-z0-9]+)"/.exec(String(st.output ?? ""))
        const acted = await update((s) => {
          const ref = s.taskCalls[callID]
          if (!ref) return false
          const entry = s.agents[ref.entryIndex]
          if (!entry || entry.status !== "working") return false
          if (m) entry.sessionId = m[1]
          entry.status = st.status === "error" ? "failed" : "done"
          entry.endedAt = new Date().toISOString()
          return true
        })
        if (acted) {
          await log(`task ${st.status} [${callID}] ${subagentType} session=${m?.[1] ?? "?"}`)
          await refreshSidebar() // freeze the row as ✓/✗ with its duration
        }
      }
      return
    }

    case "session.idle": {
      const sid = p.sessionID
      const acted = await update((s) => {
        const now = new Date().toISOString()
        if (sid === s.orchestrator) {
          let changed = false
          for (const a of s.agents) if (a.status === "working") { a.status = "done"; a.endedAt = now; changed = true }
          if (s.pendingQuestion) { s.pendingQuestion = false; changed = true }
          if (s.phase !== "done") { s.phase = "done"; s.doneAt = now; changed = true }
          else if (!s.doneAt) { s.doneAt = now; changed = true }
          return changed
        }
        const entry = s.agents.find((a) => a.sessionId === sid && a.status === "working")
        if (!entry) return false
        entry.status = "done"
        entry.endedAt = entry.endedAt ?? now
        return true
      })
      if (acted) {
        await log(`session.idle ${sid}`)
        const s2 = await readState()
        if (sid === s2.orchestrator) {
          await recordRun(s2)
          await announcePhase(s2) // "done" toast; sweep flashes 🎉 then settles ✓
        } else await refreshSidebar(s2)
      }
      return
    }

    case "session.error": {
      if (p.sessionID == null) return
      const acted = await update((s) => {
        if (p.sessionID !== s.orchestrator || s.phase === "failed") return false
        s.phase = "failed"
        s.failReason = "error"
        s.doneAt = s.doneAt ?? new Date().toISOString()
        return true
      })
      if (acted) {
        await log(`orchestrator session error: ${JSON.stringify(p).slice(0, 200)}`)
        const s2 = await readState()
        await recordRun(s2)
        await announcePhase(s2) // error toast + ✗ final titles
      }
      return
    }
  }
}
