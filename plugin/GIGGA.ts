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
 * dashboard/lib/shared.mjs with a conformance test).
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

export function projectStatePath(projectDir: string, cfgRoot: string): string {
  const slug = basename(projectDir).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "project"
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 10)
  return join(cfgRoot, "GIGGA", "projects", `${slug}-${hash}`, "state.json")
}

const CFG_ROOT = process.env.GIGGA_HOME ?? join(process.env.HOME ?? "~", ".config", "opencode")
const GIGGA_DIR = join(CFG_ROOT, "GIGGA")
const CONFIG_FILE = join(GIGGA_DIR, "GIGGA.config.json")
const LEGACY_CONFIG_FILE = join(CFG_ROOT, "gigga", "gigga.config.json")
const SERVER_FILE = join(GIGGA_DIR, "server.json")
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
  sessions: Record<string, { agent?: string; parent?: string; firstUserText?: string }>
  answeredQuestions: Record<string, boolean>
  questionCalls: Record<string, number>
  retries: number
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
})

let serverUrl: URL | null = null

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
    try {
      return JSON.parse(readFileSync(LEGACY_CONFIG_FILE, "utf8")) // pre-v0.1.0 layout
    } catch {
      return {}
    }
  }
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
  if (!serverUrl) return
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
// sidebar (ctrl+x b) lists sessions by title, so GIGGA titles its sessions
// like dashboard boxes: "⚡ GIGGA · request", "GIGGA #2 (M) · task", "✓ …".
async function setTitle(sessionID: string | null | undefined, title: string) {
  if (!serverUrl || !sessionID) return
  try {
    const res = await fetch(new URL(`session/${sessionID}`, serverUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.slice(0, 70) }),
    })
    if (!res.ok) await log(`setTitle: HTTP ${res.status}`)
  } catch (e) {
    await log(`setTitle failed: ${String(e)}`)
  }
}

const shortTask = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 40)

function sidebarTitle(entry: { kind: string; id: number; tier: Tier; task: string }, done?: "✓" | "✗") {
  const prefix = done ? `${done} ` : ""
  if (entry.kind === "worker") {
    const t = entry.tier ? `(${entry.tier[0].toUpperCase()})` : ""
    return `${prefix}GIGGA #${entry.id} ${t} · ${shortTask(entry.task)}`
  }
  return `${prefix}GIGGA ${entry.kind} · ${shortTask(entry.task)}`
}

// Mark the orchestrator's own sidebar row as finished (prefix ✓) so every
// completed run is visually closed and a new GIGGA session reads as the
// live group. Keeps opencode's auto-summary as the text.
async function markOrchestratorDone(sessionID: string | null | undefined) {
  if (!serverUrl || !sessionID) return
  try {
    const res = await fetch(new URL(`session/${sessionID}`, serverUrl), { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return
    const cur = await res.json()
    const title: string = cur?.title ?? "GIGGA run"
    if (title.startsWith("✓") || title.startsWith("✗")) return
    const s = await readState()
    const cleaned = title.replace(/^GIGGA \[[^\]]*\]\s*\S*/, "").trim() // drop our live bar + suffix
    const summary = shortTask(s.originalRequest || cleaned || title)
    await setTitle(sessionID, `✓ GIGGA [${progressBar(6)}] done · ${summary || "run finished"}`)
  } catch (e) {
    await log(`markOrchestratorDone failed: ${String(e)}`)
  }
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
  let interrupted: AgentEntry[] = []
  const acted = await update((s) => {
    const age = Date.now() - Date.parse(s.updatedAt || "0")
    if (!isFinite(age) || age < STALE_AFTER_MS) return false
    let changed = false
    interrupted = []
    for (const a of s.agents) {
      if (a.status === "working") {
        a.status = "failed"
        a.task = `${a.task} [failed (interrupted)]`.slice(0, 220)
        interrupted.push(a)
        changed = true
      }
    }
    if (changed) {
      s.phase = "failed"
      s.pendingQuestion = false
    }
    return changed
  })
  if (acted) {
    await log("recovered stale run: working agents marked failed (interrupted)")
    // sidebar honesty: mark interrupted rows so they don't look "working"
    for (const a of interrupted) await setTitle(a.sessionId, sidebarTitle(a, "✗"))
    if (interrupted.length) {
      const s = await readState()
      if (s.orchestrator) await setTitle(s.orchestrator, `✗ GIGGA [${progressBar(4)}] interrupted`)
    }
  }
}

// ------------------------------------------- TUI sidebar progress bar ------
// The TUI sidebar cannot render widgets, but the orchestrator row's TITLE is
// live-updatable — so it carries a text progress bar matching the dashboard
// stepper: READ REPO → QUESTIONS → PLAN → EXECUTE → CHECK → DONE.
const PHASE_STEPS: Record<string, number> = {
  idle: 0, recon: 1, questions: 2, plan: 3, executing: 4, checking: 5, done: 6, failed: 4,
}

function progressBar(filled: number, total = 6) {
  const f = Math.max(0, Math.min(total, filled))
  return "▓".repeat(f) + "░".repeat(total - f)
}

async function updateOrchestratorProgress(s: RunState) {
  if (!s.orchestrator) return
  const step = PHASE_STEPS[s.phase] ?? 0
  let suffix: string = s.phase
  if (s.phase === "executing") {
    const ws = s.agents.filter((a) => a.kind === "worker")
    const done = ws.filter((w) => w.status !== "working").length
    if (ws.length) suffix = `executing ${done}/${ws.length} workers`
  } else if (s.phase === "questions" && s.pendingQuestion) {
    suffix = "questions — waiting for you"
  }
  await setTitle(s.orchestrator, `GIGGA [${progressBar(step)}] ${suffix}`)
}

// ------------------------------------------------------- phase toasts ------
let lastAnnouncedPhase: string | null = null
async function announcePhase(s: RunState) {
  if (s.phase === lastAnnouncedPhase) return
  const prev = lastAnnouncedPhase
  lastAnnouncedPhase = s.phase
  const workers = s.agents.filter((a) => a.kind === "worker")
  await updateOrchestratorProgress(s)
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
      let childTitle: string | null = null
      await update((s) => {
        const cur = s.sessions[info.id] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (info.parentID) next.parent = info.parentID
        if (JSON.stringify(cur) === JSON.stringify(next)) return false
        s.sessions[info.id] = next
        if (next.agent?.toLowerCase().startsWith("GIGGA") && next.parent) {
          const entry = s.agents.find(
            (a) => a.kind === classify(next.agent!)?.kind && a.status === "working" && a.sessionId === null,
          )
          if (entry) {
            entry.sessionId = info.id
            childTitle = sidebarTitle(entry)
          }
        }
        return true
      })
      if (childTitle) await setTitle(p.info?.id, childTitle)
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
      await update((s) => {
        const cur = s.sessions[sid] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (firstUserText && !next.firstUserText) next.firstUserText = firstUserText
        let changed = false
        if (JSON.stringify(cur) !== JSON.stringify(next)) {
          s.sessions[sid] = next
          changed = true
        }
        if (sid === s.orchestrator && !s.originalRequest && next.firstUserText) {
          s.originalRequest = next.firstUserText
          orchTitle = `⚡ GIGGA · ${shortTask(next.firstUserText)}`
          changed = true
        }
        return changed
      })
      if (orchTitle) await setTitle(sid, orchTitle)
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
      await updateOrchestratorProgress(await readState())
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
          await announcePhase(await readState())
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
          return true
        })
        if (acted) {
          await log(`task ${st.status} [${callID}] ${subagentType} session=${m?.[1] ?? "?"}`)
          const s2 = await readState()
          const ref = s2.taskCalls[callID]
          const entry = ref ? s2.agents[ref.entryIndex] : null
          if (entry?.sessionId) {
            await setTitle(entry.sessionId, sidebarTitle(entry, st.status === "error" ? "✗" : "✓"))
          }
          await updateOrchestratorProgress(s2)
        }
      }
      return
    }

    case "session.idle": {
      const sid = p.sessionID
      const acted = await update((s) => {
        if (sid === s.orchestrator) {
          let changed = false
          for (const a of s.agents) if (a.status === "working") { a.status = "done"; changed = true }
          if (s.pendingQuestion) { s.pendingQuestion = false; changed = true }
          if (s.phase !== "done") { s.phase = "done"; changed = true }
          return changed
        }
        const entry = s.agents.find((a) => a.sessionId === sid && a.status === "working")
        if (!entry) return false
        entry.status = "done"
        return true
      })
      if (acted) {
        await log(`session.idle ${sid}`)
        const s2 = await readState()
        if (sid === s2.orchestrator) {
          await announcePhase(s2)
          await markOrchestratorDone(sid) // close the run's sidebar row
        }
      }
      return
    }

    case "session.error": {
      if (p.sessionID == null) return
      const acted = await update((s) => {
        if (p.sessionID !== s.orchestrator || s.phase === "failed") return false
        s.phase = "failed"
        return true
      })
      if (acted) {
        await log(`orchestrator session error: ${JSON.stringify(p).slice(0, 200)}`)
        const s2 = await readState()
        await announcePhase(s2)
        if (s2.orchestrator) await setTitle(s2.orchestrator, `✗ GIGGA [${progressBar(4)}] failed — /GIGGA-retry`)
      }
      return
    }
  }
}
