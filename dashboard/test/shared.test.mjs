import test from "node:test"
import assert from "node:assert/strict"
import { validateConfig, defaultConfig, applyTierModels, mergeStateView } from "../lib/shared.mjs"
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MODELS = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-1",
  "kimi/k3",
  "opencode/big-pickle",
]

test("validateConfig accepts a valid config", () => {
  const v = validateConfig(defaultConfig(), MODELS)
  assert.equal(v.ok, true)
  assert.deepEqual(v.errors, [])
})

test("validateConfig rejects unknown provider/model", () => {
  const cfg = { ...defaultConfig(), tiers: { ...defaultConfig().tiers, low: "nope/ghost-9" } }
  const v = validateConfig(cfg, MODELS)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes("not among the available")))
})

test("validateConfig rejects missing fields and wrong types", () => {
  assert.equal(validateConfig({}).ok, false)
  assert.equal(validateConfig(null).ok, false)
  const base = defaultConfig()
  assert.equal(validateConfig({ ...base, tiers: undefined }).ok, false)
  assert.equal(validateConfig({ ...base, defaultTier: "ultra" }).ok, false)
  assert.equal(validateConfig({ ...base, maxParallel: 0 }).ok, false)
  assert.equal(validateConfig({ ...base, maxParallel: "5" }).ok, false)
  assert.equal(validateConfig({ ...base, autoRetry: "yes" }).ok, false)
  assert.equal(validateConfig({ ...base, sound: 1 }).ok, false)
  assert.equal(validateConfig({ ...base, questionRounds: 9 }).ok, false)
  assert.equal(validateConfig({ ...base, tiers: { ...base.tiers, medium: "sonnet" } }).ok, false)
})

test("validateConfig without a model list only checks shape", () => {
  const cfg = defaultConfig()
  cfg.tiers.low = "anything/whatever"
  assert.equal(validateConfig(cfg).ok, true)
})

test("applyTierModels rewrites worker markers and orchestrator model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gigga-agents-"))
  for (const t of ["low", "medium", "high"]) {
    await writeFile(
      join(dir, `gigga-worker-${t}.md`),
      `---\ndescription: worker ${t}\nmode: subagent\nmodel: anthropic/old   # <!-- set by gigga-config -->\n---\nbody\n`,
    )
  }
  await writeFile(join(dir, "gigga.md"), `---\ndescription: orch\nmode: primary\ncolor: accent\n---\nbody\n`)

  const res = await applyTierModels(dir, { low: "kimi/k3", medium: "kimi/k3", high: "opencode/big-pickle" }, "medium")
  assert.equal(res.filter((r) => r.changed).length, 4)

  const low = await readFile(join(dir, "gigga-worker-low.md"), "utf8")
  assert.match(low, /^model: kimi\/k3   # <!-- set by gigga-config -->$/m)
  const high = await readFile(join(dir, "gigga-worker-high.md"), "utf8")
  assert.match(high, /^model: opencode\/big-pickle   # <!-- set by gigga-config -->$/m)
  const orch = await readFile(join(dir, "gigga.md"), "utf8")
  assert.match(orch, /^model: kimi\/k3$/m)

  // idempotent second run
  const res2 = await applyTierModels(dir, { low: "kimi/k3", medium: "kimi/k3", high: "opencode/big-pickle" }, "medium")
  assert.equal(res2.filter((r) => r.changed).length, 0)
})

test("mergeStateView maps phases and extracts workers", () => {
  const state = {
    phase: "executing",
    pendingQuestion: false,
    originalRequest: "x",
    agents: [
      { id: 0, kind: "orchestrator", status: "working" },
      { id: 1, kind: "worker", tier: "medium", task: "a", status: "done" },
      { id: 2, kind: "worker", tier: "low", task: "b", status: "working" },
      { id: 0, kind: "checker", status: "working" },
    ],
  }
  const v = mergeStateView(state)
  assert.equal(v.phase, "executing")
  assert.equal(v.phaseIndex, 4)
  assert.equal(v.workers.length, 2)
  assert.equal(v.workers[1].status, "working")
  assert.equal(v.others.length, 1)
  assert.ok(v.orchestrator)

  const empty = mergeStateView(null)
  assert.equal(empty.phase, "idle")
  assert.equal(empty.phaseIndex, 0)
  assert.deepEqual(empty.workers, [])
})

test("mergeStateView tolerates malformed state", () => {
  const v = mergeStateView({ phase: "bogus", agents: "not-an-array" })
  assert.equal(v.phase, "bogus")
  assert.deepEqual(v.workers, [])
})
