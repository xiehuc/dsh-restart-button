/**
 * dsh-restart-button — Host half.
 *
 * One-click restart for this DSH deployment, modeled on the dsh-market
 * self-restart logic: an HTTP POST route is served by the running Web host,
 * the browser reaches it with a plain fetch (transport-independent, no RPC
 * channel to come up missing), and the restart itself is handed to a
 * DETACHED helper process that survives this process being killed.
 *
 * On this fnOS deployment the operator's own lifecycle script
 * `/var/apps/dsh/cmd/main restart` is the correct restart: it restarts both
 * the dsh web process and the proxy, re-writes the cordis.patch.yml and the
 * privileged-fence patch, and manages the pid files as the dsh user. So the
 * detached helper runs exactly that command instead of respawning the raw
 * dsh CLI (which would skip the proxy and the env setup cmd/main performs).
 *
 * Security posture:
 *  - POST only;
 *  - same-origin (Origin === Host), and no proxy forwarding headers. We do NOT
 *    require a loopback peer like dsh-market does: this deployment is reached
 *    from the LAN (the browser connects from e.g. 192.168.1.28), so a
 *    loopback-only check would 403 every legitimate click. Same-origin is the
 *    CSRF boundary that matters here — a cross-site page cannot forge a
 *    matching Origin — and it still works over the LAN.
 *  - `allowedOrigins` (plugin config) is the explicit escape hatch for that
 *    forwarding-header rule: an origin listed there is accepted even when the
 *    request arrived through a reverse proxy, which is what makes the button
 *    work on the Caddy front door (28010 → 28000). Requests are matched on
 *    scheme + host, so `http://192.168.1.7:28010` and a bare
 *    `192.168.1.7:28010` are the same entry. Listing an origin is a deliberate
 *    operator decision to grant that exact host the right to restart; it does
 *    NOT widen the check to any other origin, and a forged Origin from a
 *    cross-site page still fails.
 *  - returns 409 if a restart is already scheduled, never racing itself.
 *
 * Suicide-style handoff (mirrors dsh-market): after spawning the detached
 * helper, the Host process SIGTERMs itself so the port is released
 * immediately; the helper detects it, runs the lifecycle restart, and the
 * replacement binds in seconds. A read-only GET /dsh-restart/status exposes
 * the current PID so the client can poll for the new boot and reload.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-restart-button'
export const inject = ['webServer']

/** The fnOS lifecycle restart command for THIS deployment. */
const RESTART_CMD = '/var/apps/dsh/cmd/main'
const RESTART_ARGS = ['restart']
const DEFAULT_PORT = 28000

/**
 * Origins allowed to trigger a restart through a reverse proxy, on top of the
 * same-origin rule. `http://192.168.1.7:28010` is this deployment's Caddy front
 * door (Caddy listens on 28010 and proxy_passes to 28000); without it the
 * forwarding headers Caddy adds would refuse every click made through the
 * proxy. Override via the plugin's `allowedOrigins` config.
 */
const DEFAULT_ALLOWED_ORIGINS = ['http://192.168.1.7:28010']

/** Build a Standard Schema issue, matching dsh-bill's shape. */
const issue = (message, ...path) => ({ message, path: path.length ? path : undefined })

/**
 * Plugin config, as a Standard Schema (see dsh-bill for the same convention).
 *
 * Cordis validates this before the fiber starts and hands the resulting value
 * to `apply(ctx, config)`, so a malformed `allowedOrigins` is refused by name
 * instead of silently disabling the escape hatch.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-restart-button',
    validate(input) {
      const defaults = () => ({ value: { allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS] } })
      // The Loader passes `undefined` for a config-less row.
      if (input === undefined || input === null) return defaults()
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [issue('expected an object')] }
      }
      const { allowedOrigins } = input
      if (allowedOrigins === undefined) return defaults()
      if (!Array.isArray(allowedOrigins)) {
        return { issues: [issue('expected an array of origins', 'allowedOrigins')] }
      }
      const issues = []
      allowedOrigins.forEach((entry, index) => {
        if (typeof entry !== 'string' || normalizeOrigin(entry) === null) {
          issues.push(issue('expected an origin like http://192.168.1.7:28010', 'allowedOrigins', String(index)))
        }
      })
      if (issues.length) return { issues }
      return { value: { allowedOrigins } }
    },
  },
}

/**
 * Canonical `scheme//host` form of one allow-list entry, or null when it is not
 * a usable http(s) origin. A bare `host:port` is read as http, so the operator
 * can write either spelling.
 */
function normalizeOrigin(entry) {
  if (typeof entry !== 'string') return null
  const text = entry.trim()
  if (text === '') return null
  try {
    const parsed = new URL(text.includes('://') ? text : `http://${text}`)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/**
 * Whether a process-control request may restart the service.
 *
 * An origin named in `allowedOrigins` is accepted outright — that is the
 * reverse-proxy escape hatch. Everything else keeps the original rule:
 * same-origin (Origin === Host) is the CSRF boundary, and requiring a loopback
 * peer as well would break legitimate LAN clients. Proxy-forwarding headers are
 * refused for non-listed origins so the Origin check cannot be laundered
 * through a forwarder.
 *
 * @param request - the incoming HTTP request.
 * @param allowedOrigins - canonical origins that bypass the forwarding rule.
 */
function trustedRestartRequest(request, allowedOrigins) {
  const origin = request.headers?.origin
  if (origin === undefined) return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (allowedOrigins.has(`${parsed.protocol}//${parsed.host}`)) return true
  const host = request.headers?.host
  if (host === undefined) return false
  if (request.headers?.forwarded !== undefined
    || request.headers?.['x-forwarded-for'] !== undefined
    || request.headers?.['x-real-ip'] !== undefined) return false
  return parsed.host === host
}

/** The port this process is serving on, read off the request that asked. */
function servingPort(request) {
  const host = request.headers?.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * The LOCAL port the replacement must see freed before it starts, read off the
 * request. A proxied request puts the front door in Host — Caddy's 28010, which
 * never closes — so probing it would just stall the helper for its full 30s
 * timeout. Those requests fall back to DEFAULT_PORT, this host's real port.
 * @returns the local port, or null to use DEFAULT_PORT.
 */
function localServingPort(request) {
  const headers = request.headers ?? {}
  const proxied = headers.forwarded !== undefined
    || headers['x-forwarded-for'] !== undefined
    || headers['x-real-ip'] !== undefined
  return proxied ? null : servingPort(request)
}

/**
 * Source for the detached helper that outlives this process and brings the
 * replacement up. Modeled on dsh-market's restartHelperSource: wait for the
 * serving port to actually go quiet (so the replacement does not die with
 * EADDRINUSE), then run the lifecycle restart, then verify something came up.
 * @param port - the port this process is serving on.
 */
function restartHelperSource(port) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-restart-${stamp}.err.log`)
  const portNum = port === null ? DEFAULT_PORT : port
  const helper = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(RESTART_CMD)}`,
    `const args = ${JSON.stringify(RESTART_ARGS)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    `const port = ${JSON.stringify(portNum)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-restart] ${line}\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    // The lifecycle script stops our process itself; wait until the port is
    // free so the replacement never races an EADDRINUSE.
    '  const until = Date.now() + 30000',
    '  while (Date.now() < until && await listening()) await sleep(250)',
    '  if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    '  await sleep(300)',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { detached: true, stdio: ["ignore", out, err], env: process.env })',
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`the replacement did not bind port ${port} within 20s — see the output log beside this one`)',
    '}',
    'main()',
  ].join('\n')
  return { helper, logOut, logErr }
}

export function apply(ctx, config = null) {
  let restarting = false

  // Canonical origins that may restart through a reverse proxy. Validated by
  // `Config` above; normalize again here so both the config and the defaults
  // are compared in one spelling.
  const allowedOrigins = new Set(
    (config?.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean),
  )

  // Read-only status: the current PID and when this process started, so the
  // client can show "last restart" info and detect the new boot by PID change.
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/status',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ pid: process.pid, startedAt: startedAtMs }))
    },
  }), 'dsh-restart-button: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart',
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!trustedRestartRequest(request, allowedOrigins)) {
        response.writeHead(403)
        response.end('restart is limited to same-origin requests')
        return
      }
      if (restarting) {
        response.writeHead(409)
        response.end('restart already scheduled')
        return
      }
      restarting = true
      try {
        const result = scheduleRestart(localServingPort(request))
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, ...result }))
      } catch (error) {
        restarting = false
        const message = error instanceof Error ? error.message : String(error)
        response.writeHead(500)
        response.end(message)
      }
    },
  }), 'dsh-restart-button: restart route')
}

/**
 * Detach a helper that runs the lifecycle restart once our port frees, then
 * SIGTERM this process so the port is released immediately. The helper
 * outlives us (detached + unref) and logs under tmpdir; the replacement binds
 * within a few seconds. This mirrors dsh-market's scheduleRestart.
 * @param port - the port this process is serving on.
 */
function scheduleRestart(port = null) {
  const { helper, logOut, logErr } = restartHelperSource(port)
  const helperProc = spawn(process.execPath, ['-e', helper], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helperProc.unref()
  // Suicide: let the response flush first, then exit so the port frees and the
  // helper can immediately bring the replacement up.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helperProc.pid, logOut, logErr }
}
