// Shared GIGGA logic used by the dashboard server (and reusable by any
// future tooling — the gigga-config agent performs the same rewrites by
// instruction; keep the semantics identical).
//
// Zero dependencies, runs under node >= 20 and bun.

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const TIERS = ["low", "medium", "high"]

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
