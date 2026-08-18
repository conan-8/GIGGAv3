import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * GIGGA plugin — session 1 skeleton.
 *
 * Logs all bus events to ~/.config/opencode/gigga/events.log and maintains
 * ~/.config/opencode/gigga/state.json for the dashboard (session 3) and the
 * pending-question signal (bell/toast, session 2).
 *
 * Real orchestration state tracking lands in session 2; this version must
 * load without errors.
 */

const STATE_DIR = join(
  process.env.GIGGA_HOME ?? join(process.env.HOME ?? "~", ".config", "opencode"),
  "gigga",
)
const STATE_FILE = join(STATE_DIR, "state.json")
const EVENTS_LOG = join(STATE_DIR, "events.log")

const DEFAULT_STATE = {
  phase: "idle" as
    | "idle"
    | "read-repo"
    | "questions"
    | "plan"
    | "execute"
    | "check"
    | "done",
  agents: [] as { id: string; status: "working" | "done" }[],
  pendingQuestion: false,
}

async function writeState(patch: Partial<typeof DEFAULT_STATE>) {
  await mkdir(STATE_DIR, { recursive: true })
  const current = await Bun.file(STATE_FILE).json().catch(() => DEFAULT_STATE)
  await writeFile(STATE_FILE, JSON.stringify({ ...DEFAULT_STATE, ...current, ...patch }, null, 2))
}

async function logEvent(line: string) {
  await mkdir(STATE_DIR, { recursive: true })
  await Bun.write(EVENTS_LOG, `${new Date().toISOString()} ${line}\n`).append
}

export const GiggaPlugin: Plugin = async ({ directory }) => {
  await writeState({})
  await logEvent(`plugin loaded (directory=${directory})`)

  return {
    async event(input) {
      const properties = input.properties ?? {}
      // Heuristic pending-question signal: the TUI asks the user something
      // (permission.asked or a question tool) while a GIGGA session runs.
      // Full logic in session 2.
      const type = input.type
      await logEvent(`${type} ${JSON.stringify(properties)}`)
      if (type === "session.idle") {
        await writeState({ phase: "idle", pendingQuestion: false })
      }
    },
  }
}
