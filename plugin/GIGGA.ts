import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"

/**
 * GIGGA plugin — orchestration state tracker (session 4, multi-run).
 *
 * Maintains PER-PROJECT state under
 *   <cfgRoot>/GIGGA/projects/<slug>-<hash10>/state.json
 * (cfgRoot = GIGGA_HOME or ~/.config/opencode; slug+hash derive from the
 * project/worktree dir — see projectStatePath, mirrored in
 * dashboard/lib/shared.mjs and plugin/GIGGA-sidebar.tsx with a conformance
 * test in dashboard/test/session4.test.mjs).
 *
 * The file holds MULTIPLE concurrent runs keyed by orchestrator session:
 *   { updatedAt, sessions: { <sid>: {agent, parent, firstUserText, createdAt} },
 *     runs: { <orchestratorSessionId>: RunState } }
 * Every event is routed to the run that owns its session, so several GIGGA
 * sessions running at once never overwrite each other; the sidebar plugin
 * shows each session its own run. Legacy single-run files are wrapped into
 * one-entry runs maps on read. Finished runs are kept for RUN_TTL_MS (so
 * switching back to a done session still shows its tree) and pruned beyond
 * MAX_RUNS / the TTL.
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
// Finished runs stay in state.json long enough to show their final tree when
// the user switches back to that session; pruned past the TTL / MAX_RUNS.
const RUN_TTL_MS = 24 * 3_600_000
const MAX_RUNS = 20

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
  // Prompt (within this session's run) this agent was spawned for. Agents
  // are grouped by it so the sidebar draws a separator between prompts.
  prompt?: number
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
  answeredQuestions: Record<string, boolean>
  questionCalls: Record<string, number>
  retries: number
  runStartedAt?: string
  promptStartedAt?: string
  doneAt?: string
  failReason?: "error" | "interrupted"
  recordedAt?: string
  // Multi-prompt: a session's run persists across prompts (the tree grows,
  // never resets). prompts[n] is the text of the n-th prompt; currentPrompt
  // is the index of the prompt currently being worked. recordedPromptCount
  // tracks how many prompts have been written to history.jsonl.
  prompts: string[]
  currentPrompt: number
  recordedPromptCount: number
}

interface SessionInfo {
  agent?: string
  parent?: string
  firstUserText?: string
  createdAt?: string
}

// The on-disk file: a project-wide session registry plus one run per GIGGA
// orchestrator session (runs are keyed by that session id).
interface ProjectState {
  updatedAt: string
  sessions: Record<string, SessionInfo>
  runs: Record<string, RunState>
}

const freshRun = (orchestrator: string | null): RunState => ({
  phase: "idle",
  pendingQuestion: false,
  originalRequest: "",
  agents: [],
  updatedAt: new Date().toISOString(),
  orchestrator,
  workerCounter: 0,
  taskCalls: {},
  answeredQuestions: {},
  questionCalls: {},
  retries: 0,
  runStartedAt: new Date().toISOString(),
  promptStartedAt: new Date().toISOString(),
  doneAt: undefined,
  failReason: undefined,
  recordedAt: undefined,
  prompts: [],
  currentPrompt: 0,
  recordedPromptCount: 0,
})

const freshProjectState = (): ProjectState => ({
  updatedAt: new Date().toISOString(),
  sessions: {},
  runs: {},
})

// Accepts the multi-run shape and the legacy single-run shape (sessions ≤4,
// one flat RunState per file) and normalizes to multi-run.
function normalizeRun(run: any): RunState {
  const r = (run ?? {}) as RunState
  if (!Array.isArray(r.prompts)) r.prompts = []
  if (typeof r.currentPrompt !== "number" || r.currentPrompt < 0) {
    r.currentPrompt = r.prompts.length ? r.prompts.length - 1 : 0
  }
  if (typeof r.recordedPromptCount !== "number" || r.recordedPromptCount < 0) {
    // Legacy runs are treated as fully recorded — never re-record their history.
    r.recordedPromptCount = r.prompts.length || (r.phase === "done" || r.phase === "failed" ? 1 : 0)
  }
  if (!r.promptStartedAt) r.promptStartedAt = r.runStartedAt ?? r.updatedAt
  return r
}

function normalizeProjectState(raw: any): ProjectState {
  if (!raw || typeof raw !== "object") return freshProjectState()
  if (raw.runs && typeof raw.runs === "object") {
    const runs: Record<string, RunState> = {}
    for (const [k, v] of Object.entries(raw.runs)) runs[k] = normalizeRun(v)
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      sessions: raw.sessions ?? {},
      runs,
    }
  }
  if (raw.phase || raw.agents || raw.orchestrator) {
    const sessions = raw.sessions ?? {}
    const run: any = { ...freshRun(null), ...raw }
    delete run.sessions
    const orch = typeof raw.orchestrator === "string" && raw.orchestrator ? raw.orchestrator : null
    run.orchestrator = orch
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      sessions,
      runs: { [orch ?? "legacy"]: normalizeRun(run) },
    }
  }
  return freshProjectState()
}

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

async function readState(): Promise<ProjectState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"))
    return normalizeProjectState(raw)
  } catch {
    return freshProjectState()
  }
}

function pruneRuns(ps: ProjectState) {
  const now = Date.now()
  for (const key of Object.keys(ps.runs)) {
    const run = ps.runs[key]
    if (run.phase !== "done" && run.phase !== "failed") continue
    const t = Date.parse(run.doneAt || run.updatedAt || "0")
    if (isFinite(t) && now - t > RUN_TTL_MS) delete ps.runs[key]
  }
  const keys = Object.keys(ps.runs)
  if (keys.length <= MAX_RUNS) return
  // Over cap: drop the oldest TERMINAL runs first (live runs are sacred).
  const terminal = keys
    .filter((k) => ps.runs[k].phase === "done" || ps.runs[k].phase === "failed")
    .sort((a, b) => Date.parse(ps.runs[a].updatedAt || "0") - Date.parse(ps.runs[b].updatedAt || "0"))
  while (Object.keys(ps.runs).length > MAX_RUNS && terminal.length) delete ps.runs[terminal.shift()!]
}

async function writeState(ps: ProjectState) {
  ps.updatedAt = new Date().toISOString()
  pruneRuns(ps)
  await mkdir(STATE_DIR, { recursive: true })
  const tmp = `${STATE_TMP}.${process.pid}.${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  await writeFile(tmp, JSON.stringify(ps, null, 2) + "\n")
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

async function update(mutate: (ps: ProjectState) => boolean): Promise<boolean> {
  return withLock(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ps = await readState()
        const before = new Map(Object.entries(ps.runs).map(([k, r]) => [k, JSON.stringify(r)]))
        if (!mutate(ps)) return false
        // Liveness stamp per run (the old single-file code bumped the one
        // updatedAt on every write): stale recovery keys off it, so only runs
        // that actually changed are stamped — an orphaned run with working
        // agents still goes stale and gets recovered.
        const now = new Date().toISOString()
        for (const [key, run] of Object.entries(ps.runs)) {
          if (before.get(key) !== JSON.stringify(run)) run.updatedAt = now
        }
        await writeState(ps)
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
//   running, and a ticking m:ss clock; frozen as
//   `✓ m:ss` / `✗ m:ss` when finished. Dots are emoji so they keep their
//   native red/yellow/green in the plain-text title.
// A 1s sweep PATCHes all rows of every live run in one pass; spinner phase,
// step pulse and the done-flash derive from wall-clock time, so concurrent
// plugin instances compute identical titles (no flapping).
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

// Clock text for the header: per-prompt time first, then the total session
// time when it differs (`0:45/12:30`). Used by the serve-mode title and
// mirrored in plugin/GIGGA-sidebar.tsx.
function clockText(s: RunState): string | null {
  const end = s.doneAt ? Date.parse(s.doneAt) : Date.now()
  const p = s.promptStartedAt ? Date.parse(s.promptStartedAt) : NaN
  const t = s.runStartedAt ? Date.parse(s.runStartedAt) : NaN
  const pms = isFinite(p) && isFinite(end) ? Math.max(0, end - p) : null
  const tms = isFinite(t) && isFinite(end) ? Math.max(0, end - t) : null
  if (pms == null && tms == null) return null
  if (pms == null) return fmtClock(tms!)
  if (tms == null) return fmtClock(pms)
  return pms === tms ? fmtClock(pms) : `${fmtClock(pms)}/${fmtClock(tms)}`
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

function orchestratorTitle(s: RunState, sec: number, flash = false): string {
  if (s.phase === "failed") {
    return s.failReason === "interrupted" ? "✗ GIGGA ▓▓▓▓░░ interrupted" : "✗ GIGGA ▓▓▓▓░░ failed — /GIGGA-retry"
  }
  if (s.phase === "done") {
    const ws = s.agents.filter((a) => a.kind === "worker" && (a.prompt ?? 0) === (s.currentPrompt ?? 0))
    const clock = clockText(s)
    const dur = clock ? ` · ${clock}` : ""
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

function childTitle(s: RunState, a: AgentEntry, idx: number, isLast: boolean, firstOfPrompt: boolean, sec: number): string {
  const promptIdx = a.prompt ?? 0
  // Serve-mode: there is no standalone separator row in the session/title
  // list, so the first subagent row of each new prompt gets a `┌─` connector
  // and a `#n` suffix to mark the prompt boundary.
  const conn = firstOfPrompt && promptIdx > 0 ? "┌─" : isLast ? "└─" : "├─"
  const sep = firstOfPrompt && promptIdx > 0 ? ` #${promptIdx}` : ""
  const name = a.kind === "worker" ? `#${a.id} ${shortTask(a.task, 22)}` : `${a.kind} ${shortTask(a.task, 18)}`
  if (a.status !== "working") {
    const clock = elapsedMs(a)
    return `${conn} ${dotOf(a)} ${name} ${a.status === "done" ? "✓" : "✗"}${clock != null ? ` ${fmtClock(clock)}` : ""}${a.status === "failed" && s.retries > 0 ? " · retry" : ""}${sep}`
  }
  const spin = SPINNER[(sec + idx) % SPINNER.length]
  const ms = elapsedMs(a)
  return `${conn} 🟡 ${name} ${spin}${ms != null ? ` · ${fmtClock(ms)}` : ""}${sep}`
}

async function renderSidebar(run: RunState, flash = false) {
  if (!run.orchestrator || !serverUrl) return
  const sec = Math.floor(Date.now() / 1000)
  const rows = run.agents.filter((a) => a.kind !== "orchestrator" && a.sessionId)
  const firstOfPrompt = rows.map((a, i) => i === 0 || (a.prompt ?? 0) !== (rows[i - 1].prompt ?? 0))
  await Promise.all([
    patchTitle(run.orchestrator, orchestratorTitle(run, sec, flash)),
    ...rows.map((a, i) => patchTitle(a.sessionId!, childTitle(run, a, i, i === rows.length - 1, firstOfPrompt[i], sec))),
  ])
}

// ---- 1s sweep: one batched pass over every row title of EVERY run; PATCHes
// only rows whose title changed since the last pass; renders finals and stops
// itself when no run is live (the done state keeps ticking ~1.6s to flash 🎉
// before settling to ✓).
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

async function sweepTick(ps?: ProjectState) {
  const s = ps ?? (await readState())
  const runs = Object.values(s.runs)
  if (!runs.length) return stopSweep()
  let keepAlive = false
  for (const run of runs) {
    if (!run.orchestrator) continue
    if (run.phase === "failed") {
      await renderSidebar(run)
      continue
    }
    if (run.phase === "done") {
      const flash = !!(run.doneAt && Date.now() - Date.parse(run.doneAt) < 1600)
      await renderSidebar(run, flash)
      if (flash) keepAlive = true
      continue
    }
    keepAlive = true
    await renderSidebar(run)
  }
  if (!keepAlive) stopSweep()
}

// Render now and keep the sweep alive while any run is active.
async function refreshSidebar(ps?: ProjectState) {
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
  await sweepTick(ps ?? (await readState()))
}

function classify(subagentType: string): { kind: Kind; tier: Tier } | null {
  const t = String(subagentType ?? "").toLowerCase()
  if (t === "gigga-recon") return { kind: "recon", tier: null }
  if (t === "gigga-checker") return { kind: "checker", tier: null }
  if (t === "gigga-fasttrack") return { kind: "fasttrack", tier: null }
  const m = /^gigga-worker-(low|medium|high)$/.exec(t)
  if (m) return { kind: "worker", tier: m[1] as Tier }
  return null
}

// Agents that can ORCHESTRATE a run: the GIGGA primary agent (any
// non-subagent name starting with "gigga"). Excludes the spawned subagent
// types (classify hits) and the scoped setup agent GIGGA-config, whose
// sessions are not runs.
function isOrchestratorAgent(agent: string | undefined): boolean {
  const a = String(agent ?? "").toLowerCase()
  if (!a.startsWith("gigga")) return false
  if (a === "gigga-config") return false
  return classify(a) === null
}

// Which run (key = orchestrator session id) owns this session? Direct run
// key, run's orchestrator, one of the run's agent sessions, or — for
// sub-subagents — transitively via the parent chain in the session registry.
function runKeyFor(ps: ProjectState, sid: string | null | undefined, seen?: Set<string>): string | null {
  if (!sid) return null
  seen ??= new Set()
  if (seen.has(sid)) return null
  seen.add(sid)
  if (ps.runs[sid]) return sid
  for (const [key, run] of Object.entries(ps.runs)) {
    if (run.orchestrator === sid) return key
    if (run.agents.some((a) => a.sessionId === sid)) return key
  }
  const parent = ps.sessions[sid]?.parent
  return parent ? runKeyFor(ps, parent, seen) : null
}

function isGiggaSession(ps: ProjectState, sessionID: string | undefined): boolean {
  if (!sessionID) return false
  if (runKeyFor(ps, sessionID)) return true
  return String(ps.sessions[sessionID]?.agent ?? "").toLowerCase().startsWith("gigga")
}

// ------------------------------------------------------------- recovery ----
async function recoverStale() {
  const recovered: string[] = []
  const acted = await update((ps) => {
    let changed = false
    const now = new Date().toISOString()
    for (const [key, run] of Object.entries(ps.runs)) {
      const age = Date.now() - Date.parse(run.updatedAt || "0")
      if (!isFinite(age) || age < STALE_AFTER_MS) continue
      let runChanged = false
      for (const a of run.agents) {
        if (a.status === "working") {
          a.status = "failed"
          a.endedAt = now
          a.task = `${a.task} [failed (interrupted)]`.slice(0, 220)
          runChanged = true
        }
      }
      if (runChanged) {
        run.phase = "failed"
        run.failReason = "interrupted"
        run.doneAt = run.doneAt ?? now
        run.pendingQuestion = false
        recovered.push(key)
        changed = true
      }
    }
    return changed
  })
  if (acted) {
    await log(`recovered stale run(s): ${recovered.join(", ") || "?"} — working agents marked failed (interrupted)`)
    const ps = await readState()
    for (const key of recovered) await recordRun(ps, key)
    await refreshSidebar(ps) // renders the ✗ final titles, then the sweep stops itself
  }
}

// ------------------------------------------- run history (self-improvement) -
// One JSON line per finished PROMPT (a session's run spans prompts now) in
// <project dir>/history.jsonl — objective metrics (durations, tier overruns,
// retries, checker rounds) the orchestrator reads at session start to plan
// better over time. Written at the terminal transitions only;
// run.recordedPromptCount claims each prompt's write so duplicate events /
// multiple plugin instances record exactly once.
const HISTORY_FILE = () => join(STATE_DIR, "history.jsonl")

function buildRunRecord(s: RunState, promptIdx?: number) {
  const idx = Math.max(0, promptIdx ?? s.currentPrompt ?? 0)
  const pAgents = s.agents.filter((a) => (a.prompt ?? 0) === idx && a.kind !== "orchestrator")
  const starts = pAgents.map((a) => (a.startedAt ? Date.parse(a.startedAt) : NaN)).filter((n) => isFinite(n))
  const ends = pAgents.map((a) => (a.endedAt ? Date.parse(a.endedAt) : NaN)).filter((n) => isFinite(n))
  const start = starts.length
    ? Math.min(...starts)
    : idx === s.currentPrompt && s.promptStartedAt
      ? Date.parse(s.promptStartedAt)
      : idx === 0 && s.runStartedAt
        ? Date.parse(s.runStartedAt)
        : NaN
  const end = ends.length ? Math.max(...ends) : s.doneAt ? Date.parse(s.doneAt) : NaN
  const dur = isFinite(start) && isFinite(end) ? Math.max(0, end - start) : undefined
  const agents = pAgents.map((a) => {
    const d = elapsedMs(a)
    const budget = a.tier ? TIER_BUDGET_MS[a.tier] : undefined
    return {
      kind: a.kind,
      tier: a.tier ?? undefined,
      status: a.status,
      durationMs: d ?? undefined,
      overBudget: budget != null && d != null ? d > budget : undefined,
    }
  })
  return {
    ts: new Date().toISOString(),
    phase: s.phase,
    failReason: s.failReason,
    prompt: idx,
    request: shortTask(s.prompts?.[idx] || s.originalRequest, 120),
    durationMs: dur,
    retries: s.retries,
    checkerInvocations: pAgents.filter((a) => a.kind === "checker").length,
    agents,
  }
}

async function recordRun(ps: ProjectState, key: string) {
  const run = ps.runs[key]
  if (!run || (run.phase !== "done" && run.phase !== "failed")) return
  const promptIdx = Math.max(0, run.currentPrompt ?? 0)
  const rec = buildRunRecord(run, promptIdx)
  const claimed = await update((st) => {
    const r = st.runs[key]
    if (!r || (r.phase !== "done" && r.phase !== "failed")) return false
    if ((r.recordedPromptCount ?? 0) > promptIdx) return false
    r.recordedPromptCount = promptIdx + 1
    if (r.recordedAt === undefined) r.recordedAt = new Date().toISOString() // legacy first-write stamp
    return true
  })
  if (!claimed) return
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await appendFile(HISTORY_FILE(), JSON.stringify(rec) + "\n")
    await log(`prompt recorded (#${promptIdx}): ${rec.phase}${rec.failReason ? ` (${rec.failReason})` : ""} ${rec.durationMs ?? "?"}ms agents=${rec.agents.length} retries=${rec.retries} (run ${key})`)
  } catch (e) {
    await log(`run record failed: ${String(e)}`)
  }
}

// ------------------------------------------------------- phase toasts ------
// Per-run dedupe (keyed by run key) so concurrent runs announce independently.
const lastAnnouncedPhase = new Map<string, string>()
async function announcePhase(key: string) {
  const run = (await readState()).runs[key]
  if (!run) return
  if (lastAnnouncedPhase.get(key) === run.phase) return
  const prev = lastAnnouncedPhase.get(key) ?? null
  lastAnnouncedPhase.set(key, run.phase)
  const workers = run.agents.filter((a) => a.kind === "worker")
  await refreshSidebar()
  switch (run.phase) {
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
        const ps = await readState()
        if (!isGiggaSession(ps, input.sessionID)) return
        const key = runKeyFor(ps, input.sessionID)
        const calls = key ? (ps.runs[key].questionCalls[input.sessionID] ?? 0) : 0
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
      if (!info.id) return
      let bound = false
      await update((ps) => {
        const cur = ps.sessions[info.id] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (info.parentID) next.parent = info.parentID
        if (!next.createdAt) next.createdAt = new Date().toISOString()
        if (JSON.stringify(cur) === JSON.stringify(next)) return false
        ps.sessions[info.id] = next
        // Bind a freshly spawned GIGGA subagent session to the pending agent
        // entry of ITS run (routed via the parent session).
        if (next.agent && classify(next.agent) && next.parent) {
          const key = runKeyFor(ps, next.parent)
          const run = key ? ps.runs[key] : null
          if (run) {
            const entry = run.agents.find(
              (a) => a.kind === classify(next.agent!)?.kind && a.status === "working" && a.sessionId === null,
            )
            if (entry) {
              entry.sessionId = info.id
              bound = true
            }
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
      let bound = false
      await update((ps) => {
        const cur = ps.sessions[sid] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (!next.createdAt) next.createdAt = new Date().toISOString()
        if (firstUserText && !next.firstUserText) next.firstUserText = firstUserText
        let changed = false
        if (JSON.stringify(cur) !== JSON.stringify(next)) {
          ps.sessions[sid] = next
          changed = true
        }
        // Each GIGGA primary session owns its own run (multi-run): concurrent
        // GIGGA sessions never overwrite each other. Subagent sessions
        // (classify hits) and parented sessions never start runs. A run is
        // SESSION-scoped, not prompt-scoped: further prompts continue the same
        // tree (new agents appended with a higher prompt index) instead of
        // resetting it.
        if (isOrchestratorAgent(next.agent ?? cur.agent) && !next.parent) {
          let run = ps.runs[sid]
          if (!run) {
            run = ps.runs[sid] = freshRun(sid)
            lastAnnouncedPhase.delete(sid)
            bound = true
            changed = true
          }
          // A new user prompt in a finished run's session starts a new prompt
          // SEGMENT: the tree keeps its past agents and the phase re-arms so
          // the sidebar shows this prompt's activity. The >3s guard keeps a
          // late-arriving update of the run's final message from re-arming.
          const userText = firstUserText ?? ""
          const isUserPrompt = info.role === "user" && userText.length > 0
          if (
            isUserPrompt &&
            (run.phase === "done" || run.phase === "failed") &&
            run.doneAt &&
            Date.now() - Date.parse(run.doneAt) > 3000
          ) {
            run.phase = "idle"
            run.pendingQuestion = false
            run.doneAt = undefined
            run.failReason = undefined
            run.retries = 0
            run.currentPrompt = run.prompts.length
            run.prompts.push(userText)
            run.promptStartedAt = new Date().toISOString()
            lastAnnouncedPhase.delete(sid)
            changed = true
          }
          if (!run.originalRequest && (firstUserText ?? next.firstUserText)) {
            run.originalRequest = (firstUserText ?? next.firstUserText)!
            if (run.prompts.length === 0) run.prompts.push(run.originalRequest)
            orchTitle = `⚡ GIGGA · ${shortTask(run.originalRequest)}`
            changed = true
          }
        }
        return changed
      })
      if (orchTitle) await setTitle(sid, orchTitle)
      if (bound) {
        await log(`run started: ${sid} (agent=${(await readState()).sessions[sid]?.agent ?? "?"})`)
        await refreshSidebar() // starts the sweep — ⚡ row goes live immediately
      }
      return
    }

    case "question.asked": {
      const rid = p.id as string
      const acted = await update((ps) => {
        if (!isGiggaSession(ps, p.sessionID)) return false
        let key = runKeyFor(ps, p.sessionID)
        if (!key) {
          // A GIGGA primary session asking before its first message.updated
          // landed: start its run here so the pending flag has a home.
          const info = ps.sessions[p.sessionID]
          if (info?.parent || !isOrchestratorAgent(info?.agent)) return false
          ps.runs[p.sessionID] = freshRun(p.sessionID)
          key = p.sessionID
        }
        const run = ps.runs[key]
        if (run.answeredQuestions[rid]) return false
        run.answeredQuestions[rid] = true
        run.questionCalls[p.sessionID] = (run.questionCalls[p.sessionID] ?? 0) + 1
        run.pendingQuestion = true
        if (["idle", "recon", "plan"].includes(run.phase)) run.phase = "questions"
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
      const acted = await update((ps) => {
        const key = p.sessionID ? runKeyFor(ps, p.sessionID) : null
        // Routed to the asking session's run; when unroutable, fall back to
        // clearing every run (legacy global behavior).
        const keys = key ? [key] : Object.keys(ps.runs)
        let changed = false
        for (const k of keys) {
          const run = ps.runs[k]
          if (run?.pendingQuestion) {
            run.pendingQuestion = false
            changed = true
          }
        }
        return changed
      })
      if (acted) await log(`${ev.type} [${p.requestID ?? ""}]`)
      return
    }

    case "message.part.updated": {
      const part = p.part
      if (part?.type !== "tool") return
      if (part.tool === "todowrite") {
        let key: string | null = null
        const acted = await update((ps) => {
          const k = runKeyFor(ps, p.sessionID)
          if (!k) return false
          const run = ps.runs[k]
          if (run.orchestrator !== p.sessionID) return false
          if (!["recon", "questions", "idle"].includes(run.phase)) return false
          run.phase = "plan"
          key = k
          return true
        })
        if (acted && key) await announcePhase(key)
        return
      }
      if (part.tool !== "task") return

      const st = part.state ?? {}
      const subagentType = String(st.input?.subagent_type ?? "")
      const cls = classify(subagentType)
      if (!cls) return
      const callID = part.callID

      if (st.status === "running") {
        let key: string | null = null
        const acted = await update((ps) => {
          const parent = String(p.sessionID ?? "")
          let k = parent ? runKeyFor(ps, parent) : null
          if (!k) {
            // First signal of a run: a task spawn from an untracked session
            // starts its own run (no more stealing another run's state).
            if (!parent) return false
            const fresh = freshRun(parent)
            fresh.agents.push({
              id: 0,
              kind: "orchestrator",
              tier: null,
              task: "orchestration",
              status: "working",
              sessionId: parent,
              parentSessionId: "",
            })
            ps.runs[parent] = fresh
            k = parent
          }
          const run = ps.runs[k]
          if (run.taskCalls[callID]) return false
          const task = String(st.input?.description ?? st.input?.prompt ?? "").slice(0, 200)
          const dup = run.agents.some(
            (a) =>
              a.kind === cls.kind &&
              a.parentSessionId === parent &&
              a.task.slice(0, 60) === task.slice(0, 60),
          )
          if (dup) {
            run.taskCalls[callID] = { entryIndex: -1, asked: true }
            return false
          }
          const entry: AgentEntry = {
            id: cls.kind === "worker" ? ++run.workerCounter : 0,
            kind: cls.kind,
            tier: cls.tier,
            task,
            status: "working",
            sessionId: null,
            parentSessionId: parent,
            startedAt: new Date().toISOString(),
            prompt: run.currentPrompt,
          }
          run.agents.push(entry)
          run.taskCalls[callID] = { entryIndex: run.agents.length - 1, asked: true }
          if (cls.kind === "recon") run.phase = "recon"
          else if (cls.kind === "worker") run.phase = "executing"
          else if (cls.kind === "checker") run.phase = "checking"
          key = k
          return true
        })
        if (acted && key) {
          await log(`task running [${callID}] ${subagentType} "${String(st.input?.description ?? "").slice(0, 60)}" (run ${key})`)
          await refreshSidebar() // explicit: announcePhase skips repeats across runs
          await announcePhase(key)
        }
        return
      }

      if (st.status === "completed" || st.status === "error") {
        const m = /<task id="(ses_[A-Za-z0-9]+)"/.exec(String(st.output ?? ""))
        const acted = await update((ps) => {
          const key = runKeyFor(ps, p.sessionID)
          if (!key) return false
          const run = ps.runs[key]
          const ref = run.taskCalls[callID]
          if (!ref) return false
          const entry = run.agents[ref.entryIndex]
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
      let orchKey: string | null = null
      const acted = await update((ps) => {
        const key = runKeyFor(ps, sid)
        if (!key) return false
        const run = ps.runs[key]
        const now = new Date().toISOString()
        if (run.orchestrator === sid) {
          let changed = false
          for (const a of run.agents) if (a.status === "working") { a.status = "done"; a.endedAt = now; changed = true }
          if (run.pendingQuestion) { run.pendingQuestion = false; changed = true }
          if (run.phase !== "done") { run.phase = "done"; run.doneAt = now; changed = true }
          else if (!run.doneAt) { run.doneAt = now; changed = true }
          if (changed) orchKey = key
          return changed
        }
        const entry = run.agents.find((a) => a.sessionId === sid && a.status === "working")
        if (!entry) return false
        entry.status = "done"
        entry.endedAt = entry.endedAt ?? now
        return true
      })
      if (acted) {
        await log(`session.idle ${sid}`)
        if (orchKey) {
          await recordRun(await readState(), orchKey)
          await announcePhase(orchKey) // "done" toast; sweep flashes 🎉 then settles ✓
        } else await refreshSidebar()
      }
      return
    }

    case "session.error": {
      if (p.sessionID == null) return
      let failedKey: string | null = null
      const acted = await update((ps) => {
        const key = runKeyFor(ps, p.sessionID)
        if (!key) return false
        const run = ps.runs[key]
        if (run.orchestrator !== p.sessionID || run.phase === "failed") return false
        run.phase = "failed"
        run.failReason = "error"
        run.doneAt = run.doneAt ?? new Date().toISOString()
        failedKey = key
        return true
      })
      if (acted && failedKey) {
        await log(`orchestrator session error: ${JSON.stringify(p).slice(0, 200)}`)
        await recordRun(await readState(), failedKey)
        await announcePhase(failedKey) // error toast + ✗ final titles
      }
      return
    }
  }
}
