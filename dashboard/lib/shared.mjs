// Shared GIGGA logic used by the dashboard server (and reusable by any
// future tooling — the gigga-config agent performs the same rewrites by
// instruction; keep the semantics identical).
//
// Zero dependencies, runs under node >= 20 and bun.

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const TIERS = ["low", "medium", "high"]

// ------------------------------------------------------ per-project state --
// MUST stay in sync with projectStatePath in plugin/gigga.ts — a conformance
// test (dashboard/test/parity.test.mjs) imports both and asserts equality.
export function projectStatePath(projectDir, cfgRoot) {
  const slug = basename(projectDir).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "project"
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 10)
  return join(cfgRoot, "gigga", "projects", `${slug}-${hash}`, "state.json")
}

// If state says agents are "working" but nothing has updated it for
// STALE_AFTER_MS, they were interrupted (e.g. opencode killed) — mark failed.
export const STALE_AFTER_MS = 120_000

export async function recoverStaleState(state, now = Date.now()) {
  if (!state || !Array.isArray(state.agents)) return { state, changed: false }
  const age = now - Date.parse(state.updatedAt || "0")
  if (!isFinite(age) || age < STALE_AFTER_MS) return { state, changed: false }
  let changed = false
  for (const a of state.agents) {
    if (a.status === "working") {
      a.status = "failed"
      a.task = `${a.task} [failed (interrupted)]`.slice(0, 220)
      changed = true
    }
  }
  if (changed) {
    state.phase = "failed"
    state.pendingQuestion = false
  }
  return { state, changed }
}

export async function readProjectState(projectDir, cfgRoot) {
  const file = projectStatePath(projectDir, cfgRoot)
  let state = null
  try {
    state = JSON.parse(await readFile(file, "utf8"))
  } catch {
    return null
  }
  const r = await recoverStaleState(state)
  if (r.changed) {
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(r.state, null, 2) + "\n")
    } catch {}
  }
  return r.state
}

// ------------------------------------------------------------- config ------
// validateConfig(cfg, availableModels?) -> { ok, errors: string[] }
// availableModels: optional array of "provider/model" strings. When given,
// every tier model must be in it (prevents saving unusable configs).
export function validateConfig(cfg, availableModels) {
  const errors = []
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, errors: ["config must be an object"] }
  }
  const tiers = cfg.tiers
  if (!tiers || typeof tiers !== "object") {
    errors.push("missing `tiers` object")
  } else {
    for (const t of TIERS) {
      const m = tiers[t]
      if (typeof m !== "string" || !/^[^/\s]+\/[\w.-]+$/.test(m)) {
        errors.push(`tiers.${t}: expected "provider/model-id" string, got ${JSON.stringify(m)}`)
      } else if (Array.isArray(availableModels) && availableModels.length && !availableModels.includes(m)) {
        errors.push(`tiers.${t}: "${m}" is not among the available opencode models`)
      }
    }
  }
  if (!TIERS.includes(cfg.defaultTier)) {
    errors.push(`defaultTier must be one of ${TIERS.join("/")}, got ${JSON.stringify(cfg.defaultTier)}`)
  }
  if (!Number.isInteger(cfg.maxParallel) || cfg.maxParallel < 1 || cfg.maxParallel > 20) {
    errors.push("maxParallel must be an integer 1..20")
  }
  if (typeof cfg.autoRetry !== "boolean") errors.push("autoRetry must be boolean")
  if (typeof cfg.sound !== "boolean") errors.push("sound must be boolean")
  if (!Number.isInteger(cfg.questionRounds) || cfg.questionRounds < 1 || cfg.questionRounds > 5) {
    errors.push("questionRounds must be an integer 1..5")
  }
  return { ok: errors.length === 0, errors }
}

export function defaultConfig() {
  return {
    tiers: { low: "anthropic/claude-haiku-4-5", medium: "anthropic/claude-sonnet-4-5", high: "anthropic/claude-opus-4-1" },
    defaultTier: "medium",
    maxParallel: 5,
    autoRetry: false,
    sound: true,
    questionRounds: 2,
  }
}

// ------------------------------------------------- worker model rewriting --
// Rewrites the `model:` lines of the gigga agent files to the chosen tier
// models. Worker files carry the machine marker comment; the orchestrator's
// plain `model:` line is inserted after `mode:` when absent.
export async function applyTierModels(agentsDir, tiers, defaultTier) {
  const results = []
  for (const tier of TIERS) {
    const file = join(agentsDir, `gigga-worker-${tier}.md`)
    const res = await rewriteModelLine(file, `model: ${tiers[tier]}   # <!-- set by gigga-config -->`)
    results.push({ file: `gigga-worker-${tier}.md`, ...res })
  }
  const orch = join(agentsDir, "gigga.md")
  const res = await rewriteModelLine(orch, `model: ${tiers[defaultTier]}`, { afterKey: "mode" })
  results.push({ file: "gigga.md", ...res })
  return results
}

async function rewriteModelLine(file, newLine, opts = {}) {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch {
    return { changed: false, note: "file not found" }
  }
  const lines = text.split("\n")
  // closing fence of the frontmatter (skip the opening one at index 0)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break }
  }
  const frontmatterEnd = end === -1 ? lines.length : end
  let at = -1
  for (let i = 1; i < frontmatterEnd; i++) {
    if (/^model:/.test(lines[i])) { at = i; break }
  }
  if (at >= 0) {
    if (lines[at] === newLine) return { changed: false, note: "already set" }
    lines[at] = newLine
  } else if (opts.afterKey) {
    let insert = 1
    for (let i = 1; i < frontmatterEnd; i++) {
      if (new RegExp(`^${opts.afterKey}:`).test(lines[i])) { insert = i + 1; break }
    }
    lines.splice(insert, 0, newLine)
  } else {
    return { changed: false, note: "no model: line and no insertion point" }
  }
  await writeFile(file, lines.join("\n"))
  return { changed: true, note: newLine }
}

// ----------------------------------------------------------- model list ----
// listModels({ serverUrl, env }) -> string[] of "provider/model"
// Prefers the opencode server HTTP API; falls back to `opencode models`.
export async function listModels({ serverUrl, env = process.env } = {}) {
  if (serverUrl) {
    try {
      const res = await fetch(new URL("config/providers", serverUrl), {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) {
        const providers = await res.json()
        const out = []
        for (const p of providers) {
          for (const m of p.models ?? []) {
            out.push(`${p.id}/${m.id}`)
          }
        }
        if (out.length) return out
      }
    } catch {}
  }
  // CLI fallback
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const run = promisify(execFile)
    const { stdout } = await run("opencode", ["models"], { env, timeout: 10000 })
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l.includes("/"))
  } catch {
    return []
  }
}

// --------------------------------------------------------- state merging ---
// state.json phases -> stepper index for the UI
const PHASE_ORDER = ["idle", "recon", "questions", "plan", "executing", "checking", "done"]

export function mergeStateView(state, extras = {}) {
  const s = state ?? { phase: "idle", pendingQuestion: false, originalRequest: "", agents: [] }
  const agents = Array.isArray(s.agents) ? s.agents : []
  const workers = agents.filter((a) => a.kind === "worker")
  return {
    phase: s.phase ?? "idle",
    phaseIndex: Math.max(0, PHASE_ORDER.indexOf(s.phase ?? "idle")),
    pendingQuestion: !!s.pendingQuestion,
    originalRequest: s.originalRequest ?? "",
    orchestrator: agents.find((a) => a.kind === "orchestrator") ?? null,
    workers: workers.map((w) => ({
      id: w.id,
      tier: w.tier,
      task: w.task,
      status: w.status,
      sessionId: w.sessionId,
    })),
    others: agents.filter((a) => ["recon", "checker", "fasttrack"].includes(a.kind)),
    ...extras,
  }
}

export function hasGiggaRun(state) {
  if (!state || !Array.isArray(state.agents)) return false
  return state.agents.length > 0
}

export const CHEAT_SHEET = [
  "HOW GIGGA WORKS",
  "1. Simple ask? Fast-tracked: one agent, straight answer.",
  "2. Bigger jobs: read-only recon inspects the repo, asks ≤ N question rounds, then states assumptions.",
  "3. A numbered worker team executes the plan in parallel (low/medium/high tier models).",
  "4. A read-only checker verifies against your original request; gaps get a retry pass.",
]

// ------------------------------------------------------------------ CLI ----
// Shared tooling used by BOTH the dashboard server and the gigga-config
// agent (the agent shells out to these — one implementation, no forks):
//   node shared.mjs validate <config.json> [modelsFile]
//   node shared.mjs apply     <agentsDir> <config.json>
//   node shared.mjs models
//   node shared.mjs status    <projectDir> [cfgRoot]
//   node shared.mjs wizard    <cfgRoot> <json>   (write config + apply + mark configured)
if (process.argv[1] && process.argv[1].endsWith("shared.mjs") && process.argv.length > 2) {
  const [, , cmd, ...rest] = process.argv
  const out = (o) => console.log(JSON.stringify(o, null, 2))
  try {
    if (cmd === "validate") {
      const cfg = JSON.parse(await readFile(rest[0], "utf8"))
      let models
      if (rest[1]) models = (await readFile(rest[1], "utf8")).split("\n").map((l) => l.trim()).filter(Boolean)
      out(validateConfig(cfg, models))
    } else if (cmd === "apply") {
      const cfg = JSON.parse(await readFile(rest[1], "utf8"))
      out({ ok: true, agentUpdates: await applyTierModels(rest[0], cfg.tiers, cfg.defaultTier) })
    } else if (cmd === "models") {
      const models = await listModels({})
      out({ ok: true, models })
    } else if (cmd === "status") {
      const cfgRoot = rest[1] ?? process.env.GIGGA_HOME ?? join(process.env.HOME, ".config", "opencode")
      const state = await readProjectState(rest[0], cfgRoot)
      out({ ok: true, state })
    } else if (cmd === "wizard") {
      // rest: cfgRoot, configJson (validated, models already checked by caller)
      const cfgRoot = rest[0]
      const cfg = JSON.parse(rest[1])
      const v = validateConfig(cfg)
      if (!v.ok) { out({ ok: false, errors: v.errors }); process.exit(1) }
      cfg.configured = true
      const giggaDir = join(cfgRoot, "gigga")
      await mkdir(giggaDir, { recursive: true })
      const cfgFile = join(giggaDir, "gigga.config.json")
      try { await stat(cfgFile); await rename(cfgFile, `${cfgFile}.backup-${Date.now()}`) } catch {}
      await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + "\n")
      const agentUpdates = await applyTierModels(join(cfgRoot, "agents"), cfg.tiers, cfg.defaultTier)
      out({ ok: true, configFile: cfgFile, agentUpdates, cheatSheet: CHEAT_SHEET })
    } else {
      out({ ok: false, errors: [`unknown command: ${cmd}`] })
      process.exit(1)
    }
  } catch (e) {
    out({ ok: false, errors: [String(e)] })
    process.exit(1)
  }
}
