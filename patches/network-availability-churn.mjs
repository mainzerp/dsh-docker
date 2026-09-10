/**
 * Mobile reconnect-churn patch for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   The client connection controller mirrors `navigator.onLine` through the
 *   `online`/`offline` window events and, on every transition, aborts the
 *   running generation:
 *
 *     setNetworkAvailable(available) { ...; this.emitState(...); this.current?.abort(...); }
 *
 *   An abort ends the Remote-stream WebSocket and pushes the controller through
 *   "connecting" into a fresh backoff cycle, which the WebUI renders as the
 *   warning indicator next to the settings entry ("reconnecting...", then
 *   "recovered").
 *
 *   That is the right reaction to a network that is really gone, but
 *   `navigator.onLine` is not that signal on mobile: Android and iOS report
 *   `offline` for routine, harmless transitions (Wi-Fi/cellular handover, radio
 *   state changes when the screen is off, brief tunnel hiccups) while the
 *   already-open socket keeps working. Measured here on 2026-09-10 with a
 *   browser driven through CDP: setting the page offline and online again
 *   produced exactly one forced reconnect — console
 *   `[connection] connection lost, retry #1`, a new `/api/remote.mux` socket and
 *   the indicator — although no packet had been lost.
 *
 * What this patch does:
 *   In @deepseek-ai/dsh-client-connection/lib/client.js the controller learns one
 *   extra fact: whether the running attempt has already delivered a connection.
 *   The flag is cleared when an attempt starts and set when that attempt reports
 *   "connected", so `setNetworkAvailable` can abort only an attempt that has not
 *   delivered anything yet:
 *     - an established connection survives the event. If the network really died,
 *       the socket fails on its own — the Host terminates it after two missed
 *       heartbeats, ~4 s — and the normal close -> retry path runs, with retries
 *       suspended while offline (the loop's own
 *       `if (!this.networkAvailable && !this.immediateRetry)` gate);
 *     - a connection still being established is aborted exactly as before;
 *     - a misreported transition costs nothing.
 *
 *   The flag is what makes this work where the controller's own `lastState` does
 *   not: measured on 2026-09-10, a flap leaves `lastState` at "disconnected" while
 *   the freshly delivered generation is live again, so a `lastState` check still
 *   aborts a healthy connection (verified: original 3 aborts over two flaps,
 *   patched 0).
 *
 * Deliberately unchanged:
 *   - `reconnect()` (manual) and the stall watchdog still abort the current
 *     generation, so an actually dead downlink is still recovered.
 *   - Backoff values, state names, and the rendered indicator are untouched.
 *   - The host half is untouched: this is purely how the browser reacts to its
 *     own OS network hints.
 *
 * Contract (same as the other patches): exact needle replacement, single-match
 * guard, `WARN:` on drift, idempotency marker, exit code stays 0 — the
 * Dockerfile greps the output and fails the build on any `WARN:`.
 *
 * Usage: node network-availability-churn.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Adapted for the dsh-docker deployment (dsh 0.1.2-rc.1, bundle-verified
 * 2026-09-10). Re-verify the needles after any DSH version bump.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const MARKER = 'dsh-docker:network-availability-churn'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const prefixArg = args.find((arg) => !arg.startsWith('--'))
const root = resolve(prefixArg ?? process.cwd())

/**
 * Locate one installed package bundle.
 *
 * A global dsh install keeps its own dependency tree one level down
 * (`<root>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`), while
 * a flat or hoisted tree has it directly under the root. Both layouts are
 * accepted, in that order.
 * @param packageName - the installed package to locate.
 * @param relative - path of the bundle inside that package.
 * @returns the first existing candidate, or the flat path when none exists.
 */
function locateBundle(packageName, relative) {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', packageName, relative),
    join(root, 'node_modules', '@deepseek-ai', packageName, relative),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]
}

const target = locateBundle('dsh-client-connection', join('lib', 'client.js'))

/**
 * Where a fresh attempt begins: the delivery flag starts cleared for it.
 */
const attemptNeedle = `				const gen = ++this.generation;`
const attemptReplacement = `				const gen = ++this.generation;
				this.attemptDelivered = false;`

/**
 * Where an attempt reports success: that attempt counts as delivered.
 */
const emitNeedle = `			emitState(state) {
				if (this.lastState === state) return;`
const emitReplacement = `			emitState(state) {
				/* ${MARKER} */
				if (state === "connected") this.attemptDelivered = true;
				if (this.lastState === state) return;`

/**
 * The tail of `setNetworkAvailable`: after the bookkeeping it emits the new
 * state, aborts whatever is in flight, and aborts a pending retry delay. The
 * patch narrows the abort to an attempt that has not delivered a connection.
 */
const needle = `				this.emitState(available ? "connecting" : "disconnected");
				if (!this.isRunning()) return;
				this.current?.abort(NETWORK_STATE_CHANGED);
				this.retryDelay?.abort(NETWORK_STATE_CHANGED);`

const replacement = `				this.emitState(available ? "connecting" : "disconnected");
				if (!this.isRunning()) return;
				/* ${MARKER}: navigator.onLine flaps on mobile without the socket being
					dead, so an established connection is left to its own failure path and
					only an attempt that has not delivered anything is aborted. */
				if (this.attemptDelivered !== true) this.current?.abort(NETWORK_STATE_CHANGED);
				this.retryDelay?.abort(NETWORK_STATE_CHANGED);`

/**
 * The field the flag lives in, next to the controller's other attempt state.
 */
const fieldNeedle = `			immediateRetry = false;`
const fieldReplacement = `			immediateRetry = false;
			/* ${MARKER}: whether the running attempt has already delivered a connection. */
			attemptDelivered = false;`

const SEAMS = [
  ['attempt state field', fieldNeedle, fieldReplacement],
  ['attempt start', attemptNeedle, attemptReplacement],
  ['connected report', emitNeedle, emitReplacement],
  ['setNetworkAvailable tail', needle, replacement],
]

if (!existsSync(target)) {
  console.log(`WARN: ${target} does not exist, skipping network-availability patch`)
  console.log('Done: 0 client bundle(s) patched')
  process.exit(0)
}

const text = readFileSync(target, 'utf8')
console.log(`Searching for the client network-availability seam in ${target}...`)

if (text.includes(MARKER)) {
  console.log('Already patched (idempotency marker present), nothing to do')
  console.log('Done: 1 file verified')
  process.exit(0)
}

let ok = true
for (const [label, seam] of SEAMS) {
  const count = text.split(seam).length - 1
  if (count !== 1) {
    console.log(`WARN: Expected 1 "${label}" match in ${target}, found ${count}`)
    ok = false
  }
}
if (!ok) {
  console.log('WARN: network-availability patch needles did not match exactly, skipping (stock handling stays in place)')
  console.log('Done: 0 client bundle(s) patched')
  process.exit(0)
}

if (checkOnly) {
  console.log(`--check: all ${SEAMS.length} needles match exactly once in ${target}; patch would apply`)
  console.log('Done: 1 file verified (nothing written)')
  process.exit(0)
}

try {
  let patched = text
  for (const [, seam, seamReplacement] of SEAMS) patched = patched.replace(seam, seamReplacement)
  writeFileSync(target, patched)
  console.log(`Patched network-availability handling into ${target}`)
  console.log('Done: 1 file patched')
} catch (err) {
  console.log(`WARN: Failed to patch ${target}: ${err.message}`)
  console.log('Done: 0 client bundle(s) patched')
  process.exit(0)
}
