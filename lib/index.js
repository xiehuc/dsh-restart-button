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
 * Whether a process-control request came from the same origin this Web host
 * is serving. Same-origin (Origin === Host) is the CSRF boundary; requiring a
 * loopback peer as well would break legitimate LAN clients. Proxy-forwarding
 * headers are still refused so the Origin check cannot be laundered through a
 * forwarder.
 */
function trustedRestartRequest(request) {
  if (request.headers?.forwarded !== undefined
    || request.headers?.['x-forwarded-for'] !== undefined
    || request.headers?.['x-real-ip'] !== undefined) return false
  const origin = request.headers?.origin
  const host = request.headers?.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
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

export function apply(ctx) {
  let restarting = false

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
      if (!trustedRestartRequest(request)) {
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
        const result = scheduleRestart(servingPort(request))
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
