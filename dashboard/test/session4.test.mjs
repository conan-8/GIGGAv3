import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)

import {
  projectStatePath, recoverStaleState, readProjectState, validateConfig, CHEAT_SHEET,
} from "../lib/shared.mjs"

test("projectStatePath: stable, namespaced, collision-resistant", () => {
  const root = "/cfg"
  const a = projectStatePath("/home/me/proj", root)
  const b = projectStatePath("/home/me/other/proj", root)
  const a2 = projectStatePath("/home/me/proj/", root)
  assert.ok(a.startsWith(join(root, "gigga", "projects", "proj-")))
  assert.notEqual(a, b)
  assert.match(a, /proj-[0-9a-f]{10}[/\\]state\.json$/)
  assert.notEqual(a, a2, "trailing slash should hash differently (documented behavior)")
})

test("projectStatePath parity with plugin/gigga.ts (node --experimental-strip-types)", async () => {
  const mod = await import("../../plugin/gigga.ts")
  for (const dir of ["/home/me/proj", "/srv/weird name/x", "C:\\repo"]) {
    assert.equal(
      mod.projectStatePath(dir, "/cfg"),
      projectStatePath(dir, "/cfg"),
      `parity failed for ${dir}`,
    )
  }
})

test("recoverStaleState marks interrupted workers failed", async () => {
  const fresh = { updatedAt: new Date().toISOString(), agents: [{ status: "working", task: "t" }] }
  assert.equal((await recoverStaleState(fresh)).changed, false)
  const stale = {
    updatedAt: new Date(Date.now() - 300_000).toISOString(),
    phase: "executing",
    pendingQuestion: true,
    agents: [
      { status: "working", task: "build it" },
      { status: "done", task: "done thing" },
    ],
  }
  const r = await recoverStaleState(stale)
  assert.equal(r.changed, true)
  assert.equal(r.state.phase, "failed")
  assert.equal(r.state.pendingQuestion, false)
  assert.equal(r.state.agents[0].status, "failed")
  assert.match(r.state.agents[0].task, /failed \(interrupted\)/)
  assert.equal(r.state.agents[1].status, "done")
})

test("readProjectState returns null when absent", async () => {
  const d = await mkdtemp(join(tmpdir(), "gigga-p-"))
  assert.equal(await readProjectState(d, "/nonexistent-cfg"), null)
})

test("validateConfig tolerates the `configured` flag", () => {
  const cfg = JSON.parse(JSON.stringify(validCfg()))
  cfg.configured = true
  assert.equal(validateConfig(cfg).ok, true)
})

function validCfg() {
  return {
    tiers: { low: "a/b", medium: "a/c", high: "a/d" },
    defaultTier: "medium",
    maxParallel: 5,
    autoRetry: false,
    sound: true,
    questionRounds: 2,
  }
}

// ---------------------------------------------------------------- CLI ------
const SHARED = new URL("../lib/shared.mjs", import.meta.url).pathname

test("CLI validate flags a bad config", async () => {
  const d = await mkdtemp(join(tmpdir(), "gigga-cli-"))
  const cfg = join(d, "c.json")
  await writeFile(cfg, JSON.stringify({ tiers: { low: "x" }, defaultTier: "nope", maxParallel: 99 }))
  const { stdout } = await run(process.execPath, [SHARED, "validate", cfg])
  const out = JSON.parse(stdout)
  assert.equal(out.ok, false)
  assert.ok(out.errors.length >= 3)
})

test("CLI wizard writes config + agent models + marks configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigga-wiz-"))
  await mkdir(join(root, "agents"), { recursive: true })
  for (const t of ["low", "medium", "high"]) {
    await writeFile(
      join(root, "agents", `gigga-worker-${t}.md`),
      `---\ndescription: w ${t}\nmode: subagent\nmodel: anthropic/old   # <!-- set by gigga-config -->\n---\nbody\n`,
    )
  }
  await writeFile(join(root, "agents", "GIGGA.md"), `---\ndescription: o\nmode: primary\n---\nbody\n`)
  const cfg = { ...validCfg(), tiers: { low: "kimi/k3", medium: "kimi/k3", high: "kimi/k3" } }
  const { stdout } = await run(process.execPath, [SHARED, "wizard", root, JSON.stringify(cfg)])
  const out = JSON.parse(stdout)
  assert.equal(out.ok, true)
  assert.equal(out.agentUpdates.filter((u) => u.changed).length, 4)
  const written = JSON.parse(await readFile(join(root, "gigga", "gigga.config.json"), "utf8"))
  assert.equal(written.configured, true)
  const worker = await readFile(join(root, "agents", "gigga-worker-low.md"), "utf8")
  assert.match(worker, /^model: kimi\/k3   # <!-- set by gigga-config -->$/m)
  assert.ok(Array.isArray(out.cheatSheet) && out.cheatSheet.length === 5)
})

test("CLI status reads per-project state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gigga-st-"))
  const proj = join(root, "myproj")
  await mkdir(proj, { recursive: true })
  const stateFile = projectStatePath(proj, root)
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify({ phase: "executing", updatedAt: new Date().toISOString(), agents: [{ kind: "worker", id: 1, status: "working" }] }))
  const { stdout } = await run(process.execPath, [SHARED, "status", proj, root])
  const out = JSON.parse(stdout)
  assert.equal(out.ok, true)
  assert.equal(out.state.phase, "executing")
})
