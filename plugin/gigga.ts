import type { Plugin } from "@opencode-ai/plugin"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * GIGGA plugin — orchestration state tracker (session 2).
 *
 * Maintains ~/.config/opencode/gigga/state.json from opencode bus events and
 * signals pending questions (bell + toast).
 *
 * Design notes (verified on opencode 1.18.18 — see DEVIATIONS.md):
 * - opencode may instantiate this plugin MORE THAN ONCE (we observed two
 *   concurrent instances → duplicated state entries and toasts). All state
 *   therefore lives in state.json on disk: every event handler re-reads,
 *   mutates, and atomically writes (tmp + rename). A mutation returns
 *   `true` only for the instance whose change actually landed, so side
 *   effects (bell/toast) fire exactly once.
 * - Event shapes: question.asked/replied/rejected; message.part.updated
 *   with part.tool === "task" (state.input.subagent_type on running,
 *   <task id="ses_…"> inside state.output on completion); message.updated
 *   with info.role/info.agent; session.created with info.parentID;
 *   session.idle / session.error.
 * - Every handler is wrapped: a plugin error must never crash opencode.
 */

const CFG_ROOT = process.env.GIGGA_HOME ?? join(process.env.HOME ?? "~", ".config", "opencode")
const GIGGA_DIR = join(CFG_ROOT, "gigga")
const STATE_FILE = join(GIGGA_DIR, "state.json")
const STATE_TMP = join(GIGGA_DIR, "state.json.tmp")
const EVENTS_LOG = join(GIGGA_DIR, "events.log")
const CONFIG_FILE = join(GIGGA_DIR, "gigga.config.json")

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
  // bookkeeping (not part of the public shape)
  orchestrator: string | null
  workerCounter: number
  taskCalls: Record<string, { entryIndex: number; asked: boolean }> // callID -> agent entry
  sessions: Record<string, { agent?: string; parent?: string; firstUserText?: string }>
  answeredQuestions: Record<string, boolean> // requestID -> handled
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
})

let serverUrl: URL | null = null

async function log(line: string) {
  try {
    await mkdir(GIGGA_DIR, { recursive: true })
    await appendFile(EVENTS_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function soundEnabled(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return cfg.sound !== false
  } catch {
    return true
  }
}

async function readState(): Promise<RunState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"))
    // tolerate files from an older/newer shape
    return { ...freshState(), ...raw }
  } catch {
    return freshState()
  }
}

async function writeState(s: RunState) {
  s.updatedAt = new Date().toISOString()
  await mkdir(GIGGA_DIR, { recursive: true })
  const pub = {
    phase: s.phase,
    pendingQuestion: s.pendingQuestion,
    originalRequest: s.originalRequest,
    agents: s.agents,
    updatedAt: s.updatedAt,
  }
  const full = { ...pub, orchestrator: s.orchestrator, workerCounter: s.workerCounter, taskCalls: s.taskCalls, sessions: s.sessions, answeredQuestions: s.answeredQuestions }
  await writeFile(STATE_TMP, JSON.stringify(full, null, 2) + "\n")
  await rename(STATE_TMP, STATE_FILE) // atomic on POSIX
}

// Read-modify-write. `mutate` returns true if it changed anything; the
// caller proceeds with side effects only when this instance's change landed.
async function update(mutate: (s: RunState) => boolean): Promise<boolean> {
  try {
    const s = await readState()
    if (!mutate(s)) return false
    await writeState(s)
    return true
  } catch (e) {
    await log(`state update failed: ${String(e)}`)
    return false
  }
}

async function bell() {
  if (!soundEnabled()) {
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
      body: JSON.stringify({ message, variant, title: "GIGGA", duration: 8000 }),
    })
    if (!res.ok) await log(`toast: HTTP ${res.status}`)
  } catch (e) {
    await log(`toast failed: ${String(e)}`)
  }
}

function classify(subagentType: string): { kind: Kind; tier: Tier } | null {
  if (subagentType === "gigga-recon") return { kind: "recon", tier: null }
  if (subagentType === "gigga-checker") return { kind: "checker", tier: null }
  if (subagentType === "gigga-fasttrack") return { kind: "fasttrack", tier: null }
  const m = /^gigga-worker-(low|medium|high)$/.exec(subagentType)
  if (m) return { kind: "worker", tier: m[1] as Tier }
  return null
}

function isGiggaSession(s: RunState, sessionID: string | undefined): boolean {
  if (!sessionID) return false
  if (sessionID === s.orchestrator) return true
  const info = s.sessions[sessionID]
  if (info?.agent?.startsWith("gigga")) return true
  if (info?.parent && info.parent === s.orchestrator) return true
  return false
}

// ---------------------------------------------------------------- plugin ---
export const GiggaPlugin: Plugin = async (input) => {
  serverUrl = input.serverUrl ?? null
  await log(`plugin loaded (directory=${input.directory})`)

  return {
    async event(input) {
      try {
        await handleEvent(input.event)
      } catch (e) {
        await log(`event handler error (${input.event?.type}): ${String(e)}`)
      }
    },
  }
}

async function handleEvent(ev: { type: string; properties?: any }) {
  const p = ev.properties ?? {}

  switch (ev.type) {
    case "session.created": {
      const info = p.info ?? {}
      await update((s) => {
        const cur = s.sessions[info.id] ?? {}
        const next = { ...cur }
        if (info.agent) next.agent = info.agent
        if (info.parentID) next.parent = info.parentID
        if (JSON.stringify(cur) === JSON.stringify(next)) return false
        s.sessions[info.id] = next
        // a gigga subagent session whose parent we track → fill its entry early
        if (next.agent?.startsWith("gigga") && next.parent) {
          const entry = s.agents.find(
            (a) => a.kind === classify(next.agent!)?.kind && a.status === "working" && a.sessionId === null,
          )
          if (entry) entry.sessionId = info.id
        }
        return true
      })
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
          changed = true
        }
        return changed
      })
      return
    }

    case "question.asked": {
      const rid = p.id as string
      const acted = await update((s) => {
        if (!isGiggaSession(s, p.sessionID)) return false
        if (s.answeredQuestions[rid]) return false // another instance already handled it
        s.answeredQuestions[rid] = true
        s.pendingQuestion = true
        if (["idle", "recon", "plan"].includes(s.phase)) s.phase = "questions"
        return true
      })
      if (!acted) return
      const q = p.questions?.[0]?.question ?? "(question)"
      await log(`question.asked [${rid}] ${String(q).slice(0, 120)}`)
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
        await update((s) => {
          if (p.sessionID !== s.orchestrator) return false
          if (!["recon", "questions", "idle"].includes(s.phase)) return false
          s.phase = "plan"
          return true
        })
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
          if (s.taskCalls[callID]) return false // already tracked (by any instance)
          const parent = p.sessionID
          if (s.orchestrator !== parent) {
            // a new parent session spawning gigga tasks starts a new run
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
        if (acted) await log(`task running [${callID}] ${subagentType} "${String(st.input?.description ?? "").slice(0, 60)}"`)
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
        if (acted) await log(`task ${st.status} [${callID}] ${subagentType} session=${m?.[1] ?? "?"}`)
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
      if (acted) await log(`session.idle ${sid}`)
      return
    }

    case "session.error": {
      if (p.sessionID == null) return
      const acted = await update((s) => {
        if (p.sessionID !== s.orchestrator || s.phase === "failed") return false
        s.phase = "failed"
        return true
      })
      if (acted) await log(`orchestrator session error: ${JSON.stringify(p).slice(0, 200)}`)
      return
    }
  }
}
