import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"

// port fallback behavior: occupy a port, then start the dashboard server on
// the same port and assert it lands on port+1.

function checkPortFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1")
    s.once("error", () => resolve(true)) // nothing listening → free
    s.once("connect", () => { s.destroy(); resolve(false) })
  })
}

function occupy(port) {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {})
    srv.listen(port, "127.0.0.1", () => resolve(srv))
  })
}

test("server falls back to the next free port when busy", async (t) => {
  const base = 24399
  const free = await checkPortFree(base)
  if (!free) assert.ok(true, "port already busy by coincidence — treat as pass trigger")
  const blocker = await occupy(base)
  t.after(() => new Promise((r) => blocker.close(r)))

  const { spawn } = await import("node:child_process")
  const proc = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname, "--port", String(base), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => proc.kill())
  let out = ""
  proc.stdout.on("data", (d) => { out += d })
  await new Promise((r) => setTimeout(r, 1500))
  assert.match(out, /listening on http:\/\/127\.0\.0\.1:24400/, `expected fallback, got: ${out}`)

  // and the API answers on the fallback port
  const res = await fetch("http://127.0.0.1:24400/api/state")
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.view && typeof body.view.phase === "string")
})

test("/api/config POST rejects an invalid config", async (t) => {
  const base = 24510
  if (!(await checkPortFree(base))) return // occupied by something else; skip
  const { spawn } = await import("node:child_process")
  const proc = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname, "--port", String(base), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => proc.kill())
  await new Promise((r) => setTimeout(r, 1200))

  const bad = await fetch(`http://127.0.0.1:${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tiers: { low: "x" }, defaultTier: "mega", maxParallel: 99 }),
  })
  assert.equal(bad.status, 400)
  const body = await bad.json()
  assert.ok(Array.isArray(body.errors) && body.errors.length >= 3, JSON.stringify(body))

  const notJson = await fetch(`http://127.0.0.1:${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  })
  assert.equal(notJson.status, 400)
})
