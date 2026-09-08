/**
 * Stream stall watchdog patch for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   The server already heartbeats its Remote-stream WebSocket: @deepseek-ai/
 *   dsh-api-gateway pings every socket and terminates it after
 *   MAX_MISSED_HEARTBEATS (= 2) missed pongs. That fixes the host side, but the
 *   browser cannot observe WebSocket ping/pong frames, and RemoteStreamMuxClient
 *   reconnects only on the socket `close`/`error` event. A silently black-holed
 *   connection (reverse proxy idle drop, WireGuard re-key, NAT timeout) therefore
 *   still leaves the WebUI frozen with no recovery until the page is reloaded.
 *
 * What this patch does:
 *   Host half   — dsh-api-gateway/lib/index.js: on every heartbeat tick, next to
 *                 socket.ping(), send the tiny application frame
 *                 {"type":"keepalive"} so the browser has an observable signal.
 *   Browser half— dsh-api-gateway/lib/client.js: drop that frame and arm a
 *                 socket-bound stall watchdog; when no frame arrives for
 *                 `globalThis.__DSH_STREAM_STALL_MS` (default 30000 ms) the
 *                 existing RemoteStreamMuxClient.reconnect() path runs, which
 *                 fails the logical streams so the domain layer reopens and
 *                 resyncs.
 *
 * Both halves are required. The host frame without the browser half makes the
 * unpatched parser reject it (carrier failure + one reconnect), and the browser
 * watchdog without the host frame reconnects every threshold on an idle system —
 * so the image build fails when either pattern is missing.
 *
 * Contract (same as enable-remote-configuration.mjs): exact needle replacement,
 * single-match guard, `WARN:` on drift, idempotency marker. Exit code stays 0;
 * the Dockerfile greps the output and fails the build on any `WARN:`.
 *
 * Usage: node stream-stall-watchdog.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Adapted for the dsh-docker deployment (dsh 0.1.2-rc.1, bundle-verified
 * 2026-09-08). Re-verify the needles after any DSH version bump.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const MARKER = '/* dsh-docker:stream-stall-watchdog */'
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const prefixArg = args.find((arg) => !arg.startsWith('--'))
const root = resolve(prefixArg ?? process.cwd())
const nm = resolve(root, 'node_modules')

/** Recursively collect files whose path ends with `suffix`. */
function collect(dir, suffix, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === '.bin' || name === '.cache') continue
    const path = join(dir, name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) collect(path, suffix, out)
    else if (path.endsWith(suffix)) out.push(path)
  }
  return out
}

/** Apply one ordered patch list to every file matching `suffix`; returns hit count. */
function patchFiles(label, suffix, patches) {
  const files = collect(nm, suffix)
  if (files.length === 0) {
    console.log(`WARN: ${label}: no file ending with ${suffix} under ${nm}`)
    return 0
  }
  let hits = 0
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch (error) {
      console.log(`WARN: ${label}: cannot read ${file}: ${error.message}`)
      continue
    }
    if (text.includes(MARKER)) {
      console.log(`Skipped ${file} (already patched)`)
      hits += 1
      continue
    }
    let next = text
    let ok = true
    for (const [name, needle, replacement] of patches) {
      const count = next.split(needle).length - 1
      if (count !== 1) {
        console.log(`WARN: ${label}: ${name} pattern found ${count} times in ${file} (expected 1)`)
        ok = false
        break
      }
      next = next.replace(needle, replacement)
    }
    if (!ok) continue
    if (checkOnly) {
      console.log(`Would patch ${file} (${label})`)
      hits += 1
      continue
    }
    try {
      writeFileSync(file, next)
      console.log(`Patched ${file} (${label})`)
      hits += 1
    } catch (error) {
      console.log(`WARN: ${label}: cannot write ${file}: ${error.message}`)
    }
  }
  return hits
}

// --- host half: application keepalive frame next to the existing ping ---
const hostPatches = [[
  'heartbeat keepalive frame',
  '\t\t\t\tthis.missedHeartbeats.set(socket, missed + 1);\n\t\t\t\tsocket.ping();',
  '\t\t\t\tthis.missedHeartbeats.set(socket, missed + 1);\n\t\t\t\tsocket.ping();\n' +
  `\t\t\t\t${MARKER} try {\n` +
  '\t\t\t\t\tsocket.send(\'{"type":"keepalive"}\');\n' +
  '\t\t\t\t} catch {}',
]]

// --- browser half: drop the keepalive frame and run a socket-bound watchdog ---
const clientPatches = [
  [
    'receive keepalive guard',
    '\t\t\treceive(socket, data) {\n\t\t\t\tif (socket !== this.socket) return;',
    '\t\t\treceive(socket, data) {\n\t\t\t\tif (socket !== this.socket) return;\n' +
    '\t\t\t\tif (typeof data === "string" && data.length < 64 && data.indexOf(\'"keepalive"\') !== -1) {\n' +
    '\t\t\t\t\tthis.armStallWatchdog(socket);\n' +
    '\t\t\t\t\treturn;\n' +
    '\t\t\t\t}',
  ],
  [
    'opened arms watchdog',
    '\t\t\t\t\t\tthis.socket = socket;\n\t\t\t\t\t\tfor (const waiter of [...this.waiters]) waiter.resolve(socket);',
    '\t\t\t\t\t\tthis.socket = socket;\n' +
    '\t\t\t\t\t\tthis.armStallWatchdog(socket);\n' +
    '\t\t\t\t\t\tfor (const waiter of [...this.waiters]) waiter.resolve(socket);',
  ],
  [
    'closed disarms watchdog',
    '\t\t\t\t\tconst closed = () => {\n\t\t\t\t\t\tif (!settled) {',
    '\t\t\t\t\tconst closed = () => {\n' +
    '\t\t\t\t\t\tthis.disarmStallWatchdog(socket);\n' +
    '\t\t\t\t\t\tif (!settled) {',
  ],
  [
    'watchdog methods',
    '\t\t\treconnect() {',
    '\t\t\t' + MARKER + '\n' +
    '\t\t\tarmStallWatchdog(socket) {\n' +
    '\t\t\t\tif (this.disposed || !this.running) return;\n' +
    '\t\t\t\tclearTimeout(this.stallTimer);\n' +
    '\t\t\t\tthis.stallSocket = socket;\n' +
    '\t\t\t\tthis.stallTimer = setTimeout(() => {\n' +
    '\t\t\t\t\tif (this.stallSocket !== socket) return;\n' +
    '\t\t\t\t\tconsole.warn("[web-runtime] api gateway stream stalled, forcing reconnect");\n' +
    '\t\t\t\t\tthis.reconnect();\n' +
    '\t\t\t\t}, globalThis.__DSH_STREAM_STALL_MS ?? 30000);\n' +
    '\t\t\t}\n' +
    '\t\t\tdisarmStallWatchdog(socket) {\n' +
    '\t\t\t\tif (this.stallSocket !== socket) return;\n' +
    '\t\t\t\tclearTimeout(this.stallTimer);\n' +
    '\t\t\t\tthis.stallTimer = void 0;\n' +
    '\t\t\t\tthis.stallSocket = void 0;\n' +
    '\t\t\t}\n' +
    '\t\t\treconnect() {',
  ],
  [
    'close clears watchdog',
    '\t\t\tasync close() {\n\t\t\t\tif (!this.disposed) {\n\t\t\t\t\tthis.disposed = true;',
    '\t\t\tasync close() {\n\t\t\t\tif (!this.disposed) {\n' +
    '\t\t\t\t\tclearTimeout(this.stallTimer);\n' +
    '\t\t\t\t\tthis.disposed = true;',
  ],
]

console.log(`Stream stall watchdog patch (${checkOnly ? 'check' : 'apply'}) over ${nm}`)
const hostHits = patchFiles('host', '/@deepseek-ai/dsh-api-gateway/lib/index.js', hostPatches)
const clientHits = patchFiles('client', '/@deepseek-ai/dsh-api-gateway/lib/client.js', clientPatches)
console.log(`Done: ${checkOnly ? 'would patch' : 'patched'} host=${hostHits} client=${clientHits}`)
