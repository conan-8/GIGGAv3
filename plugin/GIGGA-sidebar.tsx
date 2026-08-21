/** @jsxImportSource @opentui/solid */
/**
 * GIGGA sidebar — TUI slot plugin (opencode TUI plugin API, verified 1.18.18).
 *
 * Renders the GIGGA run's live progress directly into the TUI sidebar
 * (ctrl+x b): a 6-step phase bar (red while running, green once done) with
 * a flashing current step and a ticking total-run clock to its right, one
 * indicator light per subagent (done / failed / running / spawning), and a
 * tree row per subagent with a braille spinner and ticking clock for
 * workers, freezing to ✓/✗ m:ss on completion. Also raises an
 * in-TUI toast plus opencode's cross-platform attention notification (desktop
 * notification + named sound, user-tunable in tui.json) when GIGGA asks a
 * question, finishes, or fails.
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

// Fasttrack/one-shot runs: a 2-cell gap races across a full bar, one cell
// per tick — visibly accelerated next to the normal bar's slow pulse.
function fastBar(sec: number): string {
  const n = 8
  const gap = sec % n
  return Array.from({ length: n }, (_, i) => (i === gap || i === (gap + 1) % n ? "░" : "▓")).join("")
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

  const cfgRoot = () => process.env.GIGGA_HOME ?? api.state.path?.config ?? join(homedir(), ".config", "opencode")
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
          api.ui.toast({ title: "GIGGA", message: "GIGGA: failed / needs retry", variant: "error" })
          await api.attention.notify({
            title: "GIGGA",
            message: "Run failed — /GIGGA-retry",
            notification: true,
            sound: (await soundOn()) ? { name: "error" } : false,
          })
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
        if (st.mtimeMs === lastMtime) return
        lastMtime = st.mtimeMs
        const next = normalizeProjectFile(JSON.parse(await readFile(file, "utf8")))
        const nextRuns = next?.runs ?? {}
        for (const [key, run] of Object.entries(nextRuns)) {
          await notifyTransitions(prevRuns.get(key) ?? null, run)
        }
        prevRuns.clear()
        for (const [key, run] of Object.entries(nextRuns)) prevRuns.set(key, run)
        setProj(next)
      })
      .catch(() => {
        if (lastMtime !== 0) {
          lastMtime = 0
          prevRuns.clear()
          setProj(null) // state file deleted — hide the widget
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
          const keyed = pf.runs[id]
          if (keyed) return keyed
          for (const run of Object.values(pf.runs)) {
            if (run.orchestrator === id) return run
            if ((run.agents ?? []).some((a) => a.sessionId === id)) return run
          }
          return null
        }
        const visible = () => !!myRun()
        // A GIGGA session that has no run yet and was created after the
        // newest run started is FRESH (first state update hasn't landed):
        // show a placeholder instead of nothing (or another run's tree).
        const freshGigga = () => {
          const pf = proj()
          const id = props.session_id
          if (!pf || !id || myRun()) return false
          const info = pf.sessions[id]
          if (!info?.agent?.toLowerCase().startsWith("gigga")) return false
          let latest = ""
          for (const run of Object.values(pf.runs)) {
            if ((run.runStartedAt ?? "") > latest) latest = run.runStartedAt ?? ""
          }
          if (latest === "") {
            // No runs on record at all: only a JUST-created session can be
            // fresh (older ones are leftovers whose runs were pruned).
            const created = Date.parse(info.createdAt ?? "")
            return isFinite(created) && Date.now() - created < 120_000
          }
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
        // A one-shot/fasttrack run: orchestrator active, no subagents for the
        // current prompt, phase never leaves idle. (A pipeline run only looks
        // like this for the few seconds before recon spawns — cosmetic,
        // self-corrects.)
        const fasttracking = () => {
          const s = myRun()
          return !!s && s.phase === "idle" && promptAgents().length === 0
        }
        // Subagent rows interleaved with a muted separator line between
        // prompt groups — the tree continues across prompts instead of
        // resetting, and each prompt is visually delimited.
        type RowItem =
          | { sep: true; n: number; text: string }
          | { sep: false; a: AgentEntry; idx: number; last: boolean }
        const rows = (): RowItem[] => {
          const list = subagents()
          const out: RowItem[] = []
          for (let i = 0; i < list.length; i++) {
            const a = list[i]
            const p = a.prompt ?? 0
            if (p > 0 && (list[i - 1]?.prompt ?? 0) !== p) {
              out.push({ sep: true, n: p, text: shortTask(myRun()?.prompts?.[p] ?? "", 24) })
            }
            out.push({ sep: false, a, idx: i, last: i === list.length - 1 || (list[i + 1].prompt ?? 0) !== p })
          }
          return out
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
          if (fasttracking()) return `${timed(fastBar(sec()))} FASTTRACK`
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
                <text fg={dotColor(a)} wrapMode="none">●</text>
                <text fg={theme().text} wrapMode="none">{label}</text>
                <text fg={theme().warning} wrapMode="none">{spin()}</text>
                <text fg={theme().warning} wrapMode="none">{clock()}</text>
              </box>
              {titleRow}
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
                      item.sep ? (
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
