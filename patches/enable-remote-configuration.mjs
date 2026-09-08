/**
 * Docker compatibility patch for DeepSeek Harness (fail-closed).
 *
 * The browser bundle derives connection.isLoopback from
 * window.location.hostname and only mirrors the settings surface in loopback
 * ("host") mode. Any non-localhost authority (LAN IP, reverse proxy hostname)
 * therefore shows "settings are unavailable in this browser".
 *
 * Since the harness rewrite (0.1.2), the server-side PRIVILEGED_METHODS
 * loopback fence no longer exists upstream — it was replaced by the uniform
 * Host/Origin trust fence plus browser launch-token auth on every /api
 * request. Only this browser half of the patch remains, and with it the
 * DSH_ALLOW_REMOTE_CONFIGURATION flag (which only gated the deleted server
 * half and would now be a no-op).
 *
 * Security note: upstream's loopback pin is now a client-side UI courtesy,
 * not an authorization boundary. Effective access control is TRUSTED_HOSTS +
 * the per-launch token + any reverse proxy in front. Only expose the WebUI
 * behind an authenticating reverse proxy (or an otherwise trusted network):
 * anyone who can reach the UI can change settings and credentials.
 *
 * What the patch does: in every client.js bundle, force
 * connection.isLoopback = true so the settings mirror uses host mode.
 *
 * Deliberately NOT lifted: agentPreset.openDocument, settings.openDocument,
 * host.pickDirectory, host.openPath — they drive the host desktop, which does
 * not exist in a container.
 *
 * NOTE: Resilient to upstream pattern changes — warns and skips when a pattern
 *       does not match, leaving stock dsh behavior in place. The image build
 *       greps this output and fails when zero bundles were patched.
 *
 * Adapted from StefanKhor/deepseek-harness-docker (MIT), itself inspired by
 * AlliotTech/deepseek-harness-docker.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = resolve(process.argv[2] ?? process.cwd())
const nm = resolve(root, 'node_modules')

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === '.bin' || name === '.cache') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkJs(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// --- browser isLoopback (every client.js copy) ---
// Needle matches the built expression in dsh-client-connection/lib/client.js
// (source: packages/client/connection/src/client/index.ts, harness 0.1.2;
// the source's `undefined` is emitted as `void 0` by the bundler). If this
// drifts upstream, zero bundles match and the image build fails the grep-gate.
console.log('Searching for client isLoopback patterns...')
const needle = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
const replacement = 'isLoopback: true,'
let clientHits = 0
for (const file of walkJs(nm)) {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(needle)) continue
    if (text.split(needle).length - 1 !== 1) {
      console.log(`WARN: Expected 1 match in ${file}, found ${text.split(needle).length - 1}, skipping`)
      continue
    }
    writeFileSync(file, text.replace(needle, replacement))
    console.log(`Patched client ${file}`)
    clientHits += 1
  } catch (err) {
    console.log(`WARN: Failed to patch ${file}: ${err.message}`)
  }
}
if (clientHits === 0) {
  console.log('WARN: browser isLoopback pattern not found, skipping client patch')
}

console.log(`Done: patched ${clientHits} client bundle(s)`)
