/**
 * dsh-restart-button — Client half.
 *
 * Registers one additive row in the General settings panel
 * (`settings.general.item`, id `restart-button`) that restarts the whole
 * DeepSeek Harness service. Low-frequency control, so it lives in settings
 * rather than the session header.
 *
 * Transport follows dsh-market: a plain `fetch` POST to the `/dsh-restart`
 * HTTP route the Host half serves, instead of a Connection RPC channel. The
 * browser's own HTTP stack reaches the running host regardless of whether a
 * private RPC channel is present, which is exactly why the market's restart
 * button is reliable.
 *
 * STYLING — final decision (see MEMORY.md): NO custom CSS. The button is the
 * host's own `Button` component from the built-in static module
 * `@deepseek-ai/dsh-client-ui-primitives`, with `variant="outline"` (default
 * `md` size): a subtle 1px `border-l2` outline on a transparent background —
 * the same look as the Appearance panel's light/dark theme buttons. Only a
 * tiny centering wrapper is used for layout; no button styling is authored.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var el = React.createElement
    // Host's built-in UI primitives (static module, like dsh-market uses).
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Button = Primitives.Button

    exports.name = 'dsh-restart-button'
    exports.inject = ['slots']

    // ── component ───────────────────────────────────────────────────────────
    function formatTime(ts) {
      if (!ts) return ''
      try {
        var d = new Date(ts)
        if (isNaN(d.getTime())) return ''
        var pad = function (n) { return String(n).padStart(2, '0') }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      } catch (e) { return '' }
    }

    function RestartRow() {
      var state = React.useState(false)
      var restarting = state[0]
      var setRestarting = state[1]
      // Last-known status: pid + startedAt of the current running host.
      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]

      React.useEffect(function () {
        currentStatus().then(setStatus).catch(function () {})
      }, [])

      var onClick = function () {
        if (restarting) return
        setRestarting(true)
        restartAndReconnect().catch(function (err) {
          console.error('dsh-restart-button:', err)
          setRestarting(false)
        })
      }

      var meta = ''
      if (status && status.pid) {
        meta = 'PID ' + status.pid + (status.startedAt ? ' · 上次启动 ' + formatTime(status.startedAt) : '')
      }

      // Row layout mirroring the reference: text block (title + desc) on the
      // left, button on the right. NO custom button styling — the host's own
      // `Button` component carries the look; only the wrapper layout is ours.
      return el(
        'div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            width: '100%',
          },
        },
        el(
          'div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          // Title — matches the reference row's primary label styling.
          el('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary, inherit)' } }, '重启 DeepSeek Harness 服务'),
          // Sub text — muted, smaller, like the reference's desc line.
          el(
            'div',
            { style: { opacity: 0.6, fontSize: 13, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary, inherit)' } },
            '服务重启后会短暂断开，随后自动重连',
          ),
          status && status.pid ? el('div', { style: { opacity: 0.5, fontSize: 12, lineHeight: 1.4 } }, meta) : null,
        ),
        el(
          Button, {
            variant: 'outline',
            type: 'button',
            disabled: restarting,
            onClick: onClick,
            title: '重启 DeepSeek Harness 服务',
            'aria-label': '重启 DeepSeek Harness 服务',
            // Instance-level tweaks only (system md size is 36px/radius 18px):
            // a bit larger, less rounded.
            style: { height: 40, borderRadius: 14, paddingLeft: 20, paddingRight: 20, flexShrink: 0 },
          },
          restarting ? '重启中…' : '重启',
        ),
      )
    }

    // ── host transport ──────────────────────────────────────────────────────
    // Same-origin POST to the Host's /dsh-restart HTTP route. The response is
    // 202 with { ok: true } once the detached helper is scheduled; the host
    // then SIGTERMs itself. We poll the read-only /dsh-restart/status route
    // until the PID changes (a fresh boot), then reload the page automatically.
    function currentStatus() {
      return fetch('/dsh-restart/status', { cache: 'no-store' }).then(function (response) {
        if (!response.ok) throw new Error('status failed: ' + response.status)
        return response.json().catch(function () { return {} })
      })
    }

    function currentPid() {
      return currentStatus().then(function (data) { return data.pid })
    }

    function restartService() {
      return fetch('/dsh-restart', { method: 'POST' }).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            throw new Error((text && text.slice(0, 200)) || ('restart failed: ' + response.status))
          })
        }
        return response.json().catch(function () { return {} })
      })
    }

    // 检测到新 PID 后，给新服务留出一段预热时间。状态接口可能早于其他
    // Web 路由和插件恢复，立即刷新会遇到临时 404。
    var RELOAD_DELAY_MS = 3000

    // Wait (bounded) until /dsh-restart/status reports a different PID, then
    // reload. Handles the disconnect window: while the old process is gone the
    // fetch fails, and we keep retrying until the new boot answers.
    function waitForNewBoot(initialPid) {
      var deadline = Date.now() + 60000
      return new Promise(function (resolve) {
        var poll = function () {
          currentPid().then(function (pid) {
            if (pid !== undefined && pid !== initialPid) { resolve(); return }
            if (Date.now() > deadline) { resolve(); return }
            setTimeout(poll, 1200)
          }).catch(function () {
            if (Date.now() > deadline) { resolve(); return }
            setTimeout(poll, 1200)
          })
        }
        setTimeout(poll, 1200)
      })
    }

    function restartAndReconnect() {
      return currentPid().then(function (initialPid) {
        return restartService().then(function () { return waitForNewBoot(initialPid) })
      }).then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, RELOAD_DELAY_MS)
        })
      }).then(function () {
        window.location.reload()
      })
    }

    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      ctx.effect(function () {
        return slots.inject('settings.general.item', function () {
          return slots.register(
            { name: 'settings.general.item', id: 'restart-button', order: 40 },
            RestartRow,
          )
        })
      }, 'dsh-restart-button: settings row')
    }

    return module.exports
  },
})
