/** @jsxImportSource @opentui/solid */
/**
 * GIGGA sidebar — TUI slot plugin (opencode TUI plugin API, verified 1.18.18).
 *
 * Renders the GIGGA run's live progress directly into the TUI sidebar
 * (ctrl+x b): a 6-step phase bar (red while running, green once done) with
 * a flashing current step and a ticking total-run clock to its right, one
 * indicator light per subagent (done / failed / running / spawning), and a
 * tree row per subagent with a braille spinner and ticking clock for
 * workers, freezing to ✓/✗ m:ss on completion. A red "reading" row sits at
 * the tree tail while a prompt's first agent has yet to spawn; fasttrack
 * subagents render as their own red rows; a muted separator line appears
 * the instant a continuation prompt lands (before its first agent); and the
 * tree is capped at 20 agent rows with a muted "… +N earlier" head line.
 * Also raises an in-TUI toast plus opencode's cross-platform attention
 * notification (desktop notification + named sound, user-tunable in
 * tui.json) when GIGGA asks a question, finishes, or fails.
 *
 * Why this exists: in plain TUI mode opencode hosts NO HTTP server, so the
 * backend plugin's title-PATCH sidebar (plugin/GIGGA.ts) and HTTP toasts
 * cannot reach the TUI at all (DEVIATIONS #29). This plugin runs inside the
 * TUI process and polls the same per-project state.json the backend
 * maintains:
 *   <cfgRoot>/GIGGA/projects/<slug>-<hash10>/state.json
 * (projectStatePath mirrors plugin/GIGGA.ts + dashboard/lib/shared.mjs —
 * a conformance test in dashboard/test/session4.test.mjs asserts the three
 * copies stay identical).
 *
 * Multi-run: the state file holds ONE RUN PER GIGGA SESSION
 * ({ sessions, runs: { <orchestratorSessionId>: RunState } }). The widget
 * shows the run that belongs to the session currently viewed — switching
 * sessions switches the sidebar to that session's run, so several GIGGA
 * sessions running at once each get their own sidebar. Legacy single-run
 * files are wrapped on read.
 *
 * Registered via ~/.config/opencode/tui.json ("plugin" array) by install.sh.
 * Read-only: never writes state; all fs access is defensive.
 */

import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { RGBA, TextAttributes } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import { homedir } from "node:os"

// MUST stay in sync with plugin/GIGGA.ts + dashboard/lib/shared.mjs — a
// conformance test (dashboard/test/session4.test.mjs) asserts equality.
function projectStatePath(projectDir: string, cfgRoot: string): string {
  const slug = basename(projectDir).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "project"
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 10)
  return join(cfgRoot, "GIGGA", "projects", `${slug}-${hash}`, "state.json")
}

// ------------------------------------------------------------ state shape --
// Mirrors RunState/ProjectState in plugin/GIGGA.ts (the on-disk file is the
// FULL state: a project-wide session registry plus one run per orchestrator
// session).
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
  startedAt?: string
  endedAt?: string
  prompt?: number
}

interface RunState {
  phase: Phase
  pendingQuestion: boolean
  originalRequest: string
  agents: AgentEntry[]
  orchestrator?: string | null
  retries?: number
  runStartedAt?: string
  promptStartedAt?: string
  doneAt?: string
  failReason?: string
  prompts?: string[]
  currentPrompt?: number
}

interface ProjectFile {
  sessions: Record<string, { agent?: string; parent?: string; createdAt?: string }>
  runs: Record<string, RunState>
}

// Accepts the multi-run shape and the legacy single-run shape (one flat
// RunState per file) and normalizes to multi-run.
function normalizeProjectFile(raw: any): ProjectFile | null {
  if (!raw || typeof raw !== "object") return null
  if (raw.runs && typeof raw.runs === "object") {
    return { sessions: raw.sessions ?? {}, runs: raw.runs }
  }
  if (raw.phase || raw.agents) {
    const orch = typeof raw.orchestrator === "string" && raw.orchestrator ? raw.orchestrator : null
    return { sessions: raw.sessions ?? {}, runs: { [orch ?? "legacy"]: raw } }
  }
  return null
}

// ------------------------------------------------- renderers (ported) -----
// Same visual language as the title-tree in plugin/GIGGA.ts: spinner/pulse/
// flash phases derive from the 1s tick, so the widget animates without the
// backend touching the TUI at all.
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const PHASE_STEPS: Record<string, number> = {
  idle: 0, recon: 1, questions: 2, plan: 3, executing: 4, checking: 5, done: 6, failed: 4,
}
const PHASE_WORD: Record<string, string> = {
  recon: "RECON", questions: "QUESTIONS", plan: "PLAN", executing: "EXECUTE", checking: "CHECK",
}

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

const dotRank = (a: AgentEntry) => (a.status === "done" ? 0 : a.status === "failed" ? 1 : a.sessionId ? 2 : 3)

function orchBar(phase: string, sec: number): string {
  const step = PHASE_STEPS[phase] ?? 0
  if (phase === "done") return "▓".repeat(6)
  if (phase === "failed" || step === 0) return "▓".repeat(step) + "░".repeat(6 - step)
  // Current stage flashes on/off (▓ ↔ ░), one flip per tick.
  return "▓".repeat(step - 1) + (sec % 2 ? "░" : "▓") + "░".repeat(6 - step)
}

const shortTask = (s: string, max = 40) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max)

// Proper red for the GIGGA brand — theme-independent (theme().error is
// pinkish in some themes); matches the agent frontmatter color (#ff3333).
const GIGGA_RED = RGBA.fromInts(255, 51, 51)
// Theme-independent green for the finished bar (theme().success is not a
// clean green in every theme) — same family as GIGGA_RED.
const GIGGA_GREEN = RGBA.fromInts(51, 255, 51)

// ------------------------------------------------------------------ plugin -
const tui: TuiPlugin = async (api) => {
  const [proj, setProj] = createSignal<ProjectFile | null>(null)
  const [tick, setTick] = createSignal(0)
  const [flagArmed, setFlagArmed] = createSignal(false)
  let lastMtime = 0
  let lastSize = 0

  // Primary config root mirrors the backend writer (plugin/GIGGA.ts line 46):
  // GIGGA_HOME or ~/.config/opencode — opencode's config path is NOT in that
  // chain (the backend never consults it). When opencode runs with a custom/
  // XDG config dir, the GIGGA state lives under that config dir instead, so we
  // fall back to it only when the primary root has no GIGGA subdirectory while
  // the config dir does. Resolved ONCE at init (never per tick): cfgRoot()
  // returns the memo, or the primary expression while resolution is landing.
  const primaryCfgRoot = () => process.env.GIGGA_HOME ?? join(homedir(), ".config", "opencode")
  let resolvedCfgRoot: string | null = null
  void (async () => {
    const primary = primaryCfgRoot()
    try {
      await stat(join(primary, "GIGGA"))
      resolvedCfgRoot = primary
      return
    } catch {}
    const alt = api.state.path?.config
    if (alt) {
      try {
        await stat(join(alt, "GIGGA"))
        resolvedCfgRoot = alt
        return
      } catch {}
    }
    resolvedCfgRoot = primary
  })()
  const cfgRoot = () => resolvedCfgRoot ?? primaryCfgRoot()
  const stateFile = () => {
    const dir = api.state.path?.worktree || api.state.path?.directory
    return dir ? projectStatePath(dir, cfgRoot()) : null
  }
  const flagFile = () => join(cfgRoot(), "GIGGA", "fasttrack.flag")
  const soundOn = async () => {
    try {
      const cfg = JSON.parse(await readFile(join(cfgRoot(), "GIGGA", "GIGGA.config.json"), "utf8"))
      return cfg.sound !== false
    } catch {
      return true
    }
  }

  // Transitions only — the first poll is a baseline, so reopening the TUI on
  // an old finished run never fires stale alerts.
  async function notifyTransitions(prev: RunState | null, next: RunState) {
    if (!prev) return
    try {
      if (next.pendingQuestion && !prev.pendingQuestion) {
        api.ui.toast({ title: "GIGGA", message: "GIGGA is waiting for your answer", variant: "warning" })
        await api.attention.notify({
          title: "GIGGA",
          message: "GIGGA is waiting for your answer",
          notification: true,
          sound: (await soundOn()) ? { name: "question" } : false,
        })
      }
      if (next.phase !== prev.phase) {
        if (next.phase === "done") {
          api.ui.toast({ title: "GIGGA", message: "GIGGA: done", variant: "success" })
          await api.attention.notify({
            title: "GIGGA",
            message: "Run finished",
            notification: true,
            sound: (await soundOn()) ? { name: "done" } : false,
          })
        } else if (next.phase === "failed") {
          if (next.failReason === "interrupted") {
            api.ui.toast({ title: "GIGGA", message: "GIGGA: run interrupted", variant: "warning" })
            await api.attention.notify({
              title: "GIGGA",
              message: "Run interrupted",
              notification: true,
              sound: (await soundOn()) ? { name: "error" } : false,
            })
          } else {
            api.ui.toast({ title: "GIGGA", message: "GIGGA: failed / needs retry", variant: "error" })
            await api.attention.notify({
              title: "GIGGA",
              message: "Run failed — /GIGGA-retry",
              notification: true,
              sound: (await soundOn()) ? { name: "error" } : false,
            })
          }
        }
      }
    } catch {}
  }

  // 1s poll of the per-project state file (mtime-gated). The tick signal
  // fires every pass so spinner, bar pulse and clocks animate even when the
  // state file itself is unchanged. Transition alerts are tracked PER RUN so
  // concurrent runs notify independently.
  const prevRuns = new Map<string, RunState>()
  const timer = setInterval(() => {
    setTick((t) => t + 1)
    stat(flagFile()).then(
      () => setFlagArmed(true),
      () => setFlagArmed(false),
    )
    const file = stateFile()
    if (!file) return
    stat(file)
      .then(async (st) => {
        if (st.mtimeMs === lastMtime && st.size === lastSize) return
        lastMtime = st.mtimeMs
        lastSize = st.size
        const next = normalizeProjectFile(JSON.parse(await readFile(file, "utf8")))
        const nextRuns = next?.runs ?? {}
        for (const [key, run] of Object.entries(nextRuns)) {
          await notifyTransitions(prevRuns.get(key) ?? null, run)
        }
        prevRuns.clear()
        for (const [key, run] of Object.entries(nextRuns)) prevRuns.set(key, run)
        setProj(next)
      })
      .catch((err) => {
        const code = (err as { code?: string } | undefined)?.code
        if (code === "ENOENT") {
          // State file genuinely gone (stat or readFile raced past a delete):
          // hide the widget and reset the transition baseline as before.
          if (lastMtime !== 0) {
            lastMtime = 0
            lastSize = 0
            prevRuns.clear()
            setProj(null)
          }
        } else {
          // Transient error (EACCES, EIO, JSON SyntaxError, …): retry the
          // read next tick, but KEEP the widget and prevRuns so a transition
          // that happened during the outage still alerts instead of silently
          // re-baselining every run.
          lastMtime = 0
          lastSize = 0
        }
      })
  }, 1000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx: Readonly<TuiSlotContext>, props: { session_id: string }) {
        const theme = () => api.theme.current
        const sec = () => tick()
        // Session scoping (multi-run): the widget shows the run that belongs
        // to the session currently viewed — the one keyed by it, or the one
        // whose orchestrator/agent sessions include it. Switching sessions
        // switches the sidebar to that session's run.
        const myRun = (): RunState | null => {
          const pf = proj()
          const id = props.session_id
          if (!pf || !id) return null
          // Mirrors runKeyFor (plugin/GIGGA.ts): the run is keyed by its
          // orchestrator session, may list this id as orchestrator/agent, or —
          // for sub-subagents — may claim one of its ANCESTORS via the session
          // registry parent chain (walked with a seen-set against cycles).
          const runFor = (sid: string, seen: Set<string>): RunState | null => {
            if (seen.has(sid)) return null
            seen.add(sid)
            const keyed = pf.runs[sid]
            if (keyed) return keyed
            for (const run of Object.values(pf.runs)) {
              if (run.orchestrator === sid) return run
              if ((run.agents ?? []).some((a) => a.sessionId === sid)) return run
            }
            const parent = pf.sessions[sid]?.parent
            return parent ? runFor(parent, seen) : null
          }
          return runFor(id, new Set())
        }
        const visible = () => !!myRun()
        // A GIGGA session that has no run yet and was created after the
        // newest run started is FRESH (first state update hasn't landed):
        // show a placeholder instead of nothing (or another run's tree).
        const freshGigga = () => {
          sec() // 1s tick: re-evaluate so the 120s freshness window lapses.
          const pf = proj()
          const id = props.session_id
          if (!pf || !id || myRun()) return false
          const info = pf.sessions[id]
          if (!info?.agent?.toLowerCase().startsWith("gigga")) return false
          // Sessions are NEVER pruned but runs ARE: a session whose run was
          // pruned stays in the registry forever. Without gating both
          // branches, the newest such session would show an eternal READING
          // placeholder. The window applies before either branch.
          const created = Date.parse(info.createdAt ?? "")
          if (!isFinite(created) || Date.now() - created >= 120_000) return false
          let latest = ""
          for (const run of Object.values(pf.runs)) {
            if ((run.runStartedAt ?? "") > latest) latest = run.runStartedAt ?? ""
          }
          if (latest === "") return true
          return (info.createdAt ?? "") > latest
        }
        const subagents = () => (myRun()?.agents ?? []).filter((a) => a.kind !== "orchestrator")
        const currentPrompt = () => myRun()?.currentPrompt ?? 0
        const promptAgents = () => subagents().filter((a) => (a.prompt ?? 0) === currentPrompt())
        // Dots are the CURRENT prompt's traffic lights only (fall back to all
        // subagents when there is no prompt info) so past prompts don't linger.
        const dots = () => {
          const cur = promptAgents()
          const pool = cur.length ? cur : subagents()
          return [...pool].sort((x, y) => dotRank(x) - dotRank(y)).slice(0, 10)
        }
        // Synthetic red "reading" row: shown while the current prompt is still
        // idle and no agent has spawned for it yet (a fresh/continuation
        // prompt's first moments). Always the LAST tree row — it vanishes
        // once the prompt's first real agent spawns or the phase leaves idle.
        const reading = (): boolean => {
          const s = myRun()
          if (!s || s.phase !== "idle") return false
          return promptAgents().length === 0
        }
        // Subagent rows interleaved with a muted separator line between
        // prompt groups — the tree continues across prompts instead of
        // resetting, and each prompt is visually delimited.
        type RowItem =
          | { kind: "early"; n: number }
          | { kind: "sep"; n: number; text: string }
          | { kind: "row"; a: AgentEntry; idx: number; last: boolean }
        // Trailing separator: beginPromptSegment bumps currentPrompt and
        // pushes its text into prompts[] IMMEDIATELY, before any agent for it
        // exists — emit the boundary now so it appears the instant the
        // continuation prompt lands, not only once its first agent spawns.
        const trailingSep = (): RowItem | null => {
          const s = myRun()
          const p = s?.currentPrompt ?? 0
          if (!s || p <= 0 || s.phase === "done" || s.phase === "failed") return null
          if (subagents().some((a) => (a.prompt ?? 0) === p)) return null
          return { kind: "sep", n: p, text: shortTask(s.prompts?.[p] ?? "", 24) }
        }
        const rows = (): RowItem[] => {
          const list = subagents()
          const ts = trailingSep()
          // Anything rendered after the last real agent row (trailing
          // separator and/or reading row) means that row is no longer the
          // tree tail: its connector flips to ├─ and its title keeps the │
          // continuation line.
          const hasTail = ts !== null || reading()
          const out: RowItem[] = []
          for (let i = 0; i < list.length; i++) {
            const a = list[i]
            const p = a.prompt ?? 0
            if (p > 0 && (list[i - 1]?.prompt ?? 0) !== p) {
              out.push({ kind: "sep", n: p, text: shortTask(myRun()?.prompts?.[p] ?? "", 24) })
            }
            const isLast = i === list.length - 1
            const last = isLast ? !hasTail : (list[i + 1].prompt ?? 0) !== p
            out.push({ kind: "row", a, idx: i, last })
          }
          // Cap the tree at 20 AGENT rows (separators don't count): keep the
          // newest 20, drop older rows (and any separator whose group's agents
          // were all dropped), and emit a muted "… +N earlier" head line.
          const MAX = 20
          const agentCount = out.filter((it) => it.kind === "row").length
          if (agentCount <= MAX) {
            return ts ? [...out, ts] : out
          }
          const dropped = agentCount - MAX
          const capped: RowItem[] = []
          let kept = 0
          for (let i = out.length - 1; i >= 0; i--) {
            const it = out[i]
            if (it.kind === "row") {
              if (kept < MAX) {
                capped.unshift(it)
                kept++
              }
            } else if (capped.some((c) => c.kind === "row" && c.a.prompt === it.n)) {
              capped.unshift(it)
            }
          }
          if (ts) capped.push(ts)
          if (dropped > 0) capped.unshift({ kind: "early", n: dropped })
          return capped
        }
        const dotColor = (a: AgentEntry) =>
          a.status === "done"
            ? theme().success
            : a.status === "failed"
              ? theme().error
              : a.sessionId
                ? theme().warning
                : theme().textMuted

        // Header clocks: per-prompt time first, then the total session time
        // when it differs (`0:45/12:30`) — both live (Date.now()) while the
        // run is active (headerText() reads sec() on its running paths, so
        // these re-evaluate every tick) and frozen to doneAt once
        // done/failed.
        const totalClock = () => {
          const s = myRun()
          if (!s?.runStartedAt) return ""
          const start = Date.parse(s.runStartedAt)
          if (!isFinite(start)) return ""
          const end = s.doneAt ? Date.parse(s.doneAt) : Date.now()
          const d = end - start
          return isFinite(d) && d >= 0 ? fmtClock(d) : ""
        }
        const promptClock = () => {
          const s = myRun()
          if (!s?.promptStartedAt) return ""
          const start = Date.parse(s.promptStartedAt)
          if (!isFinite(start)) return ""
          const end = s.doneAt ? Date.parse(s.doneAt) : Date.now()
          const d = end - start
          return isFinite(d) && d >= 0 ? fmtClock(d) : ""
        }
        const clocks = () => {
          const p = promptClock()
          const t = totalClock()
          if (!p && !t) return ""
          if (!p) return t
          if (!t) return p
          return p === t ? p : `${p}/${t}`
        }
        const headerText = () => {
          const s = myRun()!
          const timed = (bar: string) => (clocks() ? `${bar} ${clocks()}` : bar)
          if (s.phase === "failed") {
            return s.failReason === "interrupted"
              ? `✗ ${timed("▓▓▓▓░░")} interrupted`
              : `✗ ${timed("▓▓▓▓░░")} failed — /GIGGA-retry`
          }
          if (s.phase === "done") {
            const ws = s.agents.filter((a) => a.kind === "worker" && (a.prompt ?? 0) === (s.currentPrompt ?? 0))
            const wn = ws.length ? ` · ${ws.length} worker${ws.length === 1 ? "" : "s"}` : ""
            const flash = !!(s.doneAt && Date.now() - Date.parse(s.doneAt) < 1600)
            return `${flash ? "🎉" : "✓"} ${timed("▓▓▓▓▓▓")} done${wn}`
          }
          const word =
            s.phase === "questions" && s.pendingQuestion
              ? "QUESTIONS — waiting for you"
              : s.phase === "idle"
                ? "WORKING"
                : (PHASE_WORD[s.phase] ?? s.phase.toUpperCase())
          return `${timed(orchBar(s.phase, sec()))} ${word}`
        }
        const headerColor = () => {
          const s = myRun()!
          return s.phase === "failed" ? theme().error : s.phase === "done" ? GIGGA_GREEN : GIGGA_RED
        }

        // Two rows per subagent: row 1 = indicator light, type label, and the
        // live instruments (spinner / ticking clock, or the frozen ✓/✗ m:ss);
        // row 2 = the concise task title, indented + muted.
        const row = (a: AgentEntry, idx: number, last: boolean) => {
          const conn = last ? "└─" : "├─"
          const label = a.kind === "worker" ? `worker #${a.id}` : a.kind
          const title = shortTask(a.task, 30)
          // Tree continuation: non-last rows keep the vertical line so the
          // title row stays visually attached to the tree; the last row's
          // title is plain-indented under the └─.
          const titleRow = (
            <Show when={title !== ""}>
              <box flexDirection="row" gap={0}>
                <text fg={theme().textMuted} wrapMode="none">{last ? `     ${title}` : `│    ${title}`}</text>
              </box>
            </Show>
          )
          if (a.status !== "working") {
            const clock = elapsedMs(a)
            const tail =
              `${a.status === "done" ? "✓" : "✗"}${clock != null ? ` ${fmtClock(clock)}` : ""}` +
              (a.status === "failed" && (myRun()?.retries ?? 0) > 0 ? " · retry" : "")
            return (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().textMuted} wrapMode="none">{conn}</text>
                  <text fg={dotColor(a)} wrapMode="none">●</text>
                  <text fg={theme().textMuted} wrapMode="none">{label}</text>
                  <text fg={dotColor(a)} wrapMode="none">{tail}</text>
                </box>
                {titleRow}
              </box>
            )
          }
          // Accessors (not consts): they read sec() so Solid re-evaluates
          // them on every 1s tick — the spinner animates and the clock counts
          // up by the second even when the state file is unchanged.
          // A working fasttrack subagent renders in GIGGA brand red (terminal
          // states keep status colors: done → success ✓, failed → error ✗).
          const red = a.kind === "fasttrack"
          const spin = () => SPINNER[(sec() + idx) % SPINNER.length]
          const clock = () => {
            sec()
            const ms = elapsedMs(a)
            return ms != null ? fmtClock(ms) : ""
          }
          return (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted} wrapMode="none">{conn}</text>
                <text fg={red ? GIGGA_RED : dotColor(a)} wrapMode="none">●</text>
                <text fg={red ? GIGGA_RED : theme().text} wrapMode="none">{label}</text>
                <text fg={red ? GIGGA_RED : theme().warning} wrapMode="none">{spin()}</text>
                <text fg={red ? GIGGA_RED : theme().warning} wrapMode="none">{clock()}</text>
              </box>
              {titleRow}
            </box>
          )
        }

        // Synthetic red "reading" tail row: the current prompt is idle with
        // no agent yet. Rendered as a working-agent-style row (└─ connector,
        // ● dot, `reading` label, braille spinner, ticking clock from
        // promptStartedAt ?? runStartedAt), all in GIGGA_RED. Always the last
        // tree row. Every live element reads sec() so it animates per tick.
        const readingRow = () => {
          const s = myRun()
          const start = Date.parse(s?.promptStartedAt ?? s?.runStartedAt ?? "")
          const spin = () => SPINNER[sec() % SPINNER.length]
          const clock = () => {
            sec()
            return isFinite(start) ? fmtClock(Math.max(0, Date.now() - start)) : ""
          }
          return (
            <box flexDirection="row" gap={1}>
              <text fg={GIGGA_RED} wrapMode="none">└─</text>
              <text fg={GIGGA_RED} wrapMode="none">●</text>
              <text fg={GIGGA_RED} wrapMode="none">reading</text>
              <text fg={GIGGA_RED} wrapMode="none">{spin()}</text>
              <text fg={GIGGA_RED} wrapMode="none">{clock()}</text>
            </box>
          )
        }

        return (
          <Show when={visible() || freshGigga() || flagArmed()}>
            <box flexDirection="column" paddingTop={0} paddingBottom={0} gap={0}>
              <Show when={visible()}>
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={GIGGA_RED} attributes={TextAttributes.BOLD} wrapMode="none">GIGGA</text>
                    <text fg={headerColor()} wrapMode="none">{headerText()}</text>
                  </box>
                  <Show when={dots().length > 0}>
                    <box flexDirection="row" gap={0}>
                      <For each={dots()}>{(a) => <text fg={dotColor(a)} wrapMode="none">● </text>}</For>
                    </box>
                  </Show>
                  <For each={rows()}>
                    {(item) =>
                      item.kind === "early" ? (
                        <box flexDirection="row" gap={0}>
                          <text fg={theme().textMuted} wrapMode="none">{`… +${item.n} earlier`}</text>
                        </box>
                      ) : item.kind === "sep" ? (
                        <box flexDirection="row" gap={0}>
                          <text fg={theme().textMuted} wrapMode="none">
                            {`──── #${item.n}${item.text ? ` · ${item.text}` : ""} ────`}
                          </text>
                        </box>
                      ) : (
                        row(item.a, item.idx, item.last)
                      )
                    }
                  </For>
                  <Show when={reading()}>{readingRow()}</Show>
                  <Show when={myRun()?.pendingQuestion}>
                    <text fg={theme().warning} attributes={TextAttributes.BOLD} wrapMode="none">
                      {sec() % 2 ? "▶ waiting for your answer" : "▸ waiting for your answer"}
                    </text>
                  </Show>
                </box>
              </Show>
              <Show when={!visible() && freshGigga()}>
                <box flexDirection="row" gap={1}>
                  <text fg={GIGGA_RED} attributes={TextAttributes.BOLD} wrapMode="none">GIGGA</text>
                  <text fg={theme().textMuted} wrapMode="none">{"░".repeat(6)} READING</text>
                </box>
              </Show>
              <Show when={flagArmed()}>
                <box flexDirection="row" gap={1}>
                  <Show when={!visible() && !freshGigga()}>
                    <text fg={GIGGA_RED} attributes={TextAttributes.BOLD} wrapMode="none">GIGGA</text>
                  </Show>
                  <text fg={theme().warning} attributes={TextAttributes.BOLD} wrapMode="none">
                    » FASTTRACK ARMED
                  </text>
                </box>
              </Show>
            </box>
          </Show>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "gigga.sidebar",
  tui,
}

export default plugin
