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
  normalizeProjectFile, pickDisplayRun,
} from "../lib/shared.mjs"

test("projectStatePath: stable, namespaced, collision-resistant", () => {
  const root = "/cfg"
  const a = projectStatePath("/home/me/proj", root)
  const b = projectStatePath("/home/me/other/proj", root)
  const a2 = projectStatePath("/home/me/proj/", root)
  assert.ok(a.startsWith(join(root, "GIGGA", "projects", "proj-")))
  assert.notEqual(a, b)
  assert.match(a, /proj-[0-9a-f]{10}[/\\]state\.json$/)
  assert.notEqual(a, a2, "trailing slash should hash differently (documented behavior)")
})

test("projectStatePath parity across dashboard, backend plugin, TUI plugin", async () => {
  // plugin/GIGGA.ts must export exactly one function (DEVIATIONS #28) and the
  // TUI plugin is JSX — neither can be imported here. All three copies are
  // therefore compared as normalized source text (types/whitespace stripped).
  const files = {
    "dashboard/lib/shared.mjs": new URL("../lib/shared.mjs", import.meta.url),
    "plugin/GIGGA.ts": new URL("../../plugin/GIGGA.ts", import.meta.url),
    "plugin/GIGGA-sidebar.tsx": new URL("../../plugin/GIGGA-sidebar.tsx", import.meta.url),
  }
  const bodies = {}
  for (const [name, url] of Object.entries(files)) {
    const src = await readFile(url, "utf8")
    const m = /(?:export )?function projectStatePath\([\s\S]*?\n\}/.exec(src)
    assert.ok(m, `projectStatePath not found in ${name}`)
    bodies[name] = m[0].replace(/^export /, "").replace(/: string/g, "").replace(/\s+/g, "")
  }
  assert.equal(bodies["plugin/GIGGA.ts"], bodies["dashboard/lib/shared.mjs"], "plugin/GIGGA.ts diverged from dashboard/lib/shared.mjs")
  assert.equal(bodies["plugin/GIGGA-sidebar.tsx"], bodies["dashboard/lib/shared.mjs"], "plugin/GIGGA-sidebar.tsx diverged from dashboard/lib/shared.mjs")
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
  const d = await mkdtemp(join(tmpdir(), "GIGGA-p-"))
  assert.equal(await readProjectState(d, "/nonexistent-cfg"), null)
})

// ------------------------------------------------------------ multi-run ----

function runFixture(phase, orchestrator, opts = {}) {
  return {
    phase,
    pendingQuestion: false,
    originalRequest: opts.request ?? "",
    agents: opts.agents ?? [],
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
    orchestrator,
    runStartedAt: opts.runStartedAt,
    doneAt: opts.doneAt,
  }
}

test("normalizeProjectFile: multi-run passthrough, legacy wrap, junk rejected", () => {
  const multi = { updatedAt: "u", sessions: { s1: {} }, runs: { ses_a: runFixture("executing", "ses_a") } }
  assert.deepEqual(normalizeProjectFile(multi), multi)

  const legacy = runFixture("done", "ses_old", { doneAt: new Date().toISOString(), agents: [{ kind: "worker" }] })
  legacy.sessions = { s9: { agent: "GIGGA" } }
  const pf = normalizeProjectFile(legacy)
  assert.deepEqual(Object.keys(pf.runs), ["ses_old"])
  assert.equal(pf.runs.ses_old.orchestrator, "ses_old")
  assert.equal(pf.runs.ses_old.sessions, undefined, "sessions registry is lifted out of the run")
  assert.deepEqual(pf.sessions, { s9: { agent: "GIGGA" } })

  // legacy run without an orchestrator bound yet
  const unbound = normalizeProjectFile(runFixture("idle", null))
  assert.deepEqual(Object.keys(unbound.runs), ["legacy"])

  assert.equal(normalizeProjectFile(null), null)
  assert.equal(normalizeProjectFile("nope"), null)
  assert.equal(normalizeProjectFile({ foo: 1 }), null)
})

test("pickDisplayRun prefers the newest active run, else the newest terminal", () => {
  const older = new Date(Date.now() - 60_000).toISOString()
  const newer = new Date().toISOString()
  const pf = {
    runs: {
      ses_done: runFixture("done", "ses_done", { updatedAt: newer, doneAt: newer }),
      ses_live: runFixture("executing", "ses_live", { updatedAt: older }),
    },
  }
  assert.equal(pickDisplayRun(pf).orchestrator, "ses_live", "active run wins over newer terminal run")
  const allDone = {
    runs: {
      ses_a: runFixture("done", "ses_a", { updatedAt: older }),
      ses_b: runFixture("failed", "ses_b", { updatedAt: newer }),
    },
  }
  assert.equal(pickDisplayRun(allDone).orchestrator, "ses_b")
  assert.equal(pickDisplayRun({ runs: {} }), null)
  assert.equal(pickDisplayRun(null), null)
})

test("readProjectState serves each concurrent run (display = active) and migrates legacy", async () => {
  const root = await mkdtemp(join(tmpdir(), "GIGGA-mr-"))
  const proj = join(root, "proj")
  await mkdir(proj, { recursive: true })
  const stateFile = projectStatePath(proj, root)
  await mkdir(dirname(stateFile), { recursive: true })

  // two concurrent runs: one executing, one done
  const file = {
    updatedAt: new Date().toISOString(),
    sessions: {},
    runs: {
      ses_one: runFixture("executing", "ses_one", { request: "run one", agents: [{ kind: "worker", id: 1, status: "working" }] }),
      ses_two: runFixture("done", "ses_two", { request: "run two", doneAt: new Date().toISOString() }),
    },
  }
  await writeFile(stateFile, JSON.stringify(file))
  const state = await readProjectState(proj, root)
  assert.equal(state.orchestrator, "ses_one", "dashboard shows the active run")
  assert.equal(state.originalRequest, "run one")
  // both runs stay on disk — the sidebar can still serve ses_two's session
  const onDisk = JSON.parse(await readFile(stateFile, "utf8"))
  assert.deepEqual(Object.keys(onDisk.runs).sort(), ["ses_one", "ses_two"])

  // legacy single-run file is wrapped and served
  await writeFile(stateFile, JSON.stringify(runFixture("checking", "ses_legacy")))
  const legacy = await readProjectState(proj, root)
  assert.equal(legacy.orchestrator, "ses_legacy")
  assert.equal(legacy.phase, "checking")
})

test("readProjectState recovers a stale run among multiple runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "GIGGA-mrst-"))
  const proj = join(root, "proj")
  await mkdir(proj, { recursive: true })
  const stateFile = projectStatePath(proj, root)
  await mkdir(dirname(stateFile), { recursive: true })
  const staleAt = new Date(Date.now() - 300_000).toISOString()
  const file = {
    updatedAt: staleAt,
    sessions: {},
    runs: {
      ses_dead: { ...runFixture("executing", "ses_dead", { updatedAt: staleAt }), agents: [{ status: "working", task: "x" }] },
      ses_live: runFixture("executing", "ses_live", { agents: [{ status: "working", task: "y" }] }),
    },
  }
  await writeFile(stateFile, JSON.stringify(file))
  const state = await readProjectState(proj, root)
  assert.equal(state.orchestrator, "ses_live", "fresh run is the display run")
  const onDisk = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(onDisk.runs.ses_dead.phase, "failed", "stale run marked failed")
  assert.equal(onDisk.runs.ses_dead.agents[0].status, "failed")
  assert.equal(onDisk.runs.ses_live.agents[0].status, "working", "fresh run untouched")
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
  const d = await mkdtemp(join(tmpdir(), "GIGGA-cli-"))
  const cfg = join(d, "c.json")
  await writeFile(cfg, JSON.stringify({ tiers: { low: "x" }, defaultTier: "nope", maxParallel: 99 }))
  const { stdout } = await run(process.execPath, [SHARED, "validate", cfg])
  const out = JSON.parse(stdout)
  assert.equal(out.ok, false)
  assert.ok(out.errors.length >= 3)
})

test("CLI wizard writes config + agent models + marks configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "GIGGA-wiz-"))
  await mkdir(join(root, "agents"), { recursive: true })
  for (const t of ["low", "medium", "high"]) {
    await writeFile(
      join(root, "agents", `GIGGA-worker-${t}.md`),
      `---\ndescription: w ${t}\nmode: subagent\nmodel: anthropic/old   # <!-- set by GIGGA-config -->\n---\nbody\n`,
    )
  }
  await writeFile(join(root, "agents", "GIGGA.md"), `---\ndescription: o\nmode: primary\n---\nbody\n`)
  const cfg = { ...validCfg(), tiers: { low: "kimi/k3", medium: "kimi/k3", high: "kimi/k3" } }
  const { stdout } = await run(process.execPath, [SHARED, "wizard", root, JSON.stringify(cfg)])
  const out = JSON.parse(stdout)
  assert.equal(out.ok, true)
  assert.equal(out.agentUpdates.filter((u) => u.changed).length, 4)
  const written = JSON.parse(await readFile(join(root, "GIGGA", "GIGGA.config.json"), "utf8"))
  assert.equal(written.configured, true)
  const worker = await readFile(join(root, "agents", "GIGGA-worker-low.md"), "utf8")
  assert.match(worker, /^model: kimi\/k3   # <!-- set by GIGGA-config -->$/m)
  assert.ok(Array.isArray(out.cheatSheet) && out.cheatSheet.length === 5)
})

test("CLI status reads per-project state", async () => {
  const root = await mkdtemp(join(tmpdir(), "GIGGA-st-"))
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
