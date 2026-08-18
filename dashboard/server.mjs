// GIGGA dashboard server — zero-dependency local web app.
//
//   node dashboard/server.mjs [--port 4399] [--no-open]
//
// Serves the static UI and a small API over GIGGA's state:
//   GET  /api/state                      merged view (state.json + server info)
//   GET  /api/session/:id/messages       agent conversation (HTTP → sqlite fallback)
//   GET  /api/events                     SSE: live state.json changes
//   POST /api/fasttrack                  write the fasttrack flag file
//   GET  /api/config                     config + available models
//   POST /api/config                     validate + save config, rewrite agent models
//
// Env overrides (for testing): GIGGA_HOME (config dir, default
// ~/.config/opencode), GIGGA_DATA_DIR (opencode data dir, default
// ~/.local/share/opencode). Never touches opencode; all reads defensive.

import http from "node:http"
import { readFile, writeFile, stat } from "node:fs/promises"
import { existsSync, watchFile, unwatchFile } from "node:fs"
import { join, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"

import {
  validateConfig, defaultConfig, applyTierModels, listModels, mergeStateView, hasGiggaRun,
  projectStatePath, readProjectState, CHEAT_SHEET,
} from "./lib/shared.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const GIGGA_HOME = process.env.GIGGA_HOME ?? join(os.homedir(), ".config", "opencode")
const GIGGA_DIR = join(GIGGA_HOME, "gigga")
const DATA_DIR = process.env.GIGGA_DATA_DIR ?? join(os.homedir(), ".local", "share", "opencode")
// The dashboard serves ONE project: the directory it was launched from
// (override with GIGGA_PROJECT_DIR — used by the e2e driver).
const PROJECT_DIR = process.env.GIGGA_PROJECT_DIR ?? process.cwd()
const STATE_FILE = projectStatePath(PROJECT_DIR, GIGGA_HOME)
const CONFIG_FILE = join(GIGGA_DIR, "gigga.config.json")
const SERVER_FILE = join(GIGGA_DIR, "server.json")
const FLAG_FILE = join(GIGGA_DIR, "fasttrack.flag")
const PUBLIC_DIR = join(HERE, "public")

// ------------------------------------------------------------------ args ---
const argv = process.argv.slice(2)
function argVal(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}
const WANT_PORT = argVal("--port", 4399)
const OPEN = !argv.includes("--no-open")

// ---------------------------------------------------------------- helpers --
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return null }
}

async function readServerInfo() {
  const s = await readJson(SERVER_FILE)
  if (!s?.url) return { url: null, reachable: false, updatedAt: null }
  let reachable = false
  try {
    const r = await fetch(new URL("global/health", s.url), { signal: AbortSignal.timeout(1000) })
    reachable = r.ok
  } catch {}
  return { url: s.url, reachable, updatedAt: s.updatedAt ?? null }
}

async function readStateRaw() { return readProjectState(PROJECT_DIR, GIGGA_HOME) }

// sqlite fallback (opencode 1.18 persists sessions in opencode.db).
// Read-only; if node:sqlite is unavailable or the db is absent → null.
let sqliteMod = null
async function readSessionFromDisk(sessionID) {
  const dbPath = join(DATA_DIR, "opencode.db")
  if (!existsSync(dbPath)) return null
  try {
    sqliteMod ??= await import("node:sqlite")
    const { DatabaseSync } = sqliteMod
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const msgs = db.prepare(
        "select id, data from message where session_id = ? order by time_created asc",
      ).all(sessionID)
      const parts = db.prepare(
        "select message_id, data from part where session_id = ? order by time_created asc",
      ).all(sessionID)
      const byMsg = new Map()
      for (const p of parts) {
        if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, [])
        byMsg.get(p.message_id).push(typeof p.data === "string" ? JSON.parse(p.data) : p.data)
      }
      return msgs.map((m) => {
        const d = typeof m.data === "string" ? JSON.parse(m.data) : m.data
        return { info: d, parts: byMsg.get(m.id) ?? [] }
      })
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

async function fetchSessionMessages(sessionID, serverInfo) {
  if (serverInfo?.reachable) {
    try {
      const r = await fetch(new URL(`session/${sessionID}/message`, serverInfo.url), {
        signal: AbortSignal.timeout(2500),
      })
      if (r.ok) {
        const body = await r.json()
        const messages = Array.isArray(body) ? body : body.messages ?? []
        return { source: "server", messages }
      }
    } catch {}
  }
  const fromDisk = await readSessionFromDisk(sessionID)
  if (fromDisk) return { source: "disk", messages: fromDisk }
  return { source: "unavailable", messages: [], note: "Thinking unavailable — opencode server not reachable and no stored session on disk (status only)." }
}

// ------------------------------------------------------------------- SSE ---
const sseClients = new Set()
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

// state.json live updates: fs.watchFile polling (robust across editors/atomics)
let lastStateMtime = 0
async function pollState() {
  try {
    const st = await stat(STATE_FILE)
    if (st.mtimeMs !== lastStateMtime) {
      lastStateMtime = st.mtimeMs
      broadcast("state", await readStateRaw())
    }
  } catch {
    if (lastStateMtime !== 0) { lastStateMtime = 0; broadcast("state", null) }
  }
}
watchFile(STATE_FILE, { interval: 400 }, () => pollState())

// ----------------------------------------------------------------- server --
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname

  // -- static
  if (req.method === "GET" && !path.startsWith("/api/")) {
    let file = path === "/" ? "/index.html" : path
    const full = join(PUBLIC_DIR, file)
    if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" })
    try {
      const data = await readFile(full)
      res.writeHead(200, {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
        "cache-control": "no-store",
      })
      return res.end(data)
    } catch {
      return json(res, 404, { error: "not found" })
    }
  }

  // -- API
  if (path === "/api/state" && req.method === "GET") {
    const [state, server, cfgExists] = await Promise.all([readStateRaw(), readServerInfo(), existsSync(CONFIG_FILE)])
    return json(res, 200, {
      view: mergeStateView(state, {}),
      state,
      server,
      hasRun: hasGiggaRun(state),
      configExists: existsSync(CONFIG_FILE),
      configured: !!(cfgExists && (await readJson(CONFIG_FILE))?.configured),
      project: PROJECT_DIR,
    })
  }

  const m = path.match(/^\/api\/session\/([A-Za-z0-9_-]+)\/messages$/)
  if (m && req.method === "GET") {
    const out = await fetchSessionMessages(m[1], await readServerInfo())
    return json(res, 200, out)
  }

  if (path === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    res.write("retry: 2000\n\n")
    sseClients.add(res)
    // push current state immediately
    readStateRaw().then((s) => {
      try { res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`) } catch {}
    })
    const hb = setInterval(() => {
      try { res.write(": hb\n\n") } catch { clearInterval(hb) }
    }, 15000)
    req.on("close", () => { clearInterval(hb); sseClients.delete(res) })
    return
  }

  if (path === "/api/fasttrack" && req.method === "POST") {
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(GIGGA_DIR, { recursive: true })
      await writeFile(FLAG_FILE, `${new Date().toISOString()}\n`)
      return json(res, 200, { ok: true, note: "Fasttrack armed — next request will skip planning." })
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e) })
    }
  }

  if (path === "/api/config" && req.method === "GET") {
    const cfg = await readJson(CONFIG_FILE)
    const server = await readServerInfo()
    const models = await listModels({ serverUrl: server.reachable ? server.url : null })
    return json(res, 200, { config: cfg, configExists: existsSync(CONFIG_FILE), configured: !!cfg?.configured, models, defaults: defaultConfig(), cheatSheet: CHEAT_SHEET })
  }

  if (path === "/api/config" && req.method === "POST") {
    let body = ""
    for await (const chunk of req) body += chunk
    let parsed
    try { parsed = JSON.parse(body) } catch { return json(res, 400, { ok: false, errors: ["invalid JSON body"] }) }
    const server = await readServerInfo()
    const models = await listModels({ serverUrl: server.reachable ? server.url : null })
    const v = validateConfig(parsed, models.length ? models : undefined)
    if (!v.ok) return json(res, 400, { ok: false, errors: v.errors })
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(GIGGA_DIR, { recursive: true })
      parsed.configured = true
      await writeFile(CONFIG_FILE, JSON.stringify(parsed, null, 2) + "\n")
    } catch (e) {
      return json(res, 500, { ok: false, errors: [`failed to write config: ${e}`] })
    }
    let agentUpdates = []
    try {
      agentUpdates = await applyTierModels(join(GIGGA_HOME, "agents"), parsed.tiers, parsed.defaultTier)
    } catch (e) {
      agentUpdates = [{ error: String(e) }]
    }
    return json(res, 200, { ok: true, agentUpdates })
  }

  return json(res, 404, { error: "not found" })
}

function listen(port, tries = 20) {
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { json(res, 500, { error: String(e) }) } catch {}
    })
  })
  return new Promise((resolve) => {
    srv.once("error", () => {
      if (tries > 0) {
        process.stdout.write(`port ${port} busy, trying ${port + 1}\n`)
        resolve(listen(port + 1, tries - 1))
      } else {
        process.stderr.write("no free port found\n")
        process.exit(1)
      }
    })
    srv.listen(port, "127.0.0.1", () => resolve(srv))
  })
}

const srv = await listen(WANT_PORT)
const addr = srv.address()
const urlStr = `http://127.0.0.1:${addr.port}`
console.log(`GIGGA dashboard listening on ${urlStr}`)
console.log(`  config dir: ${GIGGA_DIR}`)
console.log(`  project:    ${PROJECT_DIR}`)
console.log(`  data dir:   ${DATA_DIR}`)

if (OPEN) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try { execFileSync(opener, [urlStr], { stdio: "ignore", detached: true }) } catch {}
}

const shutdown = () => { try { srv.close() } catch {}; process.exit(0) }
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
