/**
 * Reverse-proxy auth trust patch for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   Every Host RPC call, every WebSocket stream and the index document itself
 *   sit behind one browser-session gate: `BrowserAuth.isAuthenticated` in
 *   @deepseek-ai/dsh-client-connection/lib/index.js. `dsh web` prints a
 *   per-process `?token=` URL; a root request with that token mints an HMAC
 *   cookie, and the cookie is bound to the exact request authority
 *   (normalized `Host`, port included) — `https://dsh.example.net` and
 *   `http://192.168.1.10:3080` are two different credentials. A cleared cookie
 *   or a changed authority therefore costs the 401 "dsh web authentication
 *   required; reopen the URL printed by dsh web" until the printed URL is
 *   opened again. The token itself is per process and shared by every user, so
 *   a deployment that already authenticates at a reverse proxy carries a second
 *   gate it cannot use for per-user authorization or revocation.
 *
 * What this patch does:
 *   It prepends one check to `BrowserAuth.isAuthenticated`. Only while
 *   `DSH_TRUST_REVERSE_PROXY_AUTH` is truthy (1/true/yes/on):
 *     - with `DSH_PROXY_AUTH_SECRET` unset, every request passes the gate;
 *     - with `DSH_PROXY_AUTH_SECRET` set, a request passes only when the header
 *       `x-dsh-proxy-auth` carries that secret (constant-time comparison), i.e.
 *       only requests the authenticating proxy forwarded.
 *   An unset flag or an unmatched secret leaves the shipped code path exactly
 *   as it is — the image defaults to stock 401 behavior.
 *
 * What deliberately stays in place:
 *   - the Host/Origin browser-trust fence (`isTrustedApiRequest`): a request
 *     still needs a loopback `Host` or a `TRUSTED_HOSTS` entry, and an attached
 *     `Origin` must equal that `Host`, so DNS-rebinding and cross-site browser
 *     requests stay refused with 403;
 *   - cookie minting and the `?token=` exchange: `authenticatedUrl` keeps
 *     printing a usable URL and a valid token still mints a cookie.
 *
 * Security note: the flag removes authentication, not reachability. With the
 * flag on, the network path to the port plus the trust fence are the only
 * gates, and a `Host` header is not authentication — anyone who can reach the
 * port can claim a trusted authority. Restrict the published port to the proxy
 * (or to the VPN interface), or set `DSH_PROXY_AUTH_SECRET` and let the proxy
 * inject the header.
 *
 * The environment is read once at module load, so changing either variable
 * needs a container recreate (as with every other container environment
 * variable).
 *
 * Contract (same as the other patches): exact needle replacement, single-match
 * guard, `WARN:` on drift, idempotency marker, exit code stays 0 — the
 * Dockerfile greps the output and fails the build on any `WARN:`.
 *
 * Usage: node trusted-proxy-auth.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Verified against dsh 0.1.2-rc.1 (bundle-verified 2026-09-10).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TARGET = 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'
const MARKER = 'dsh-docker:trusted-proxy-auth'

// Anchor: the browser-auth region's own constants (source:
// packages/client/connection/src/browser-auth.ts). Stable, tab-free and unique
// inside the bundle.
const ANCHOR_NEEDLE = 'const DAY_MILLISECONDS = 1440 * 60 * 1e3;'
const ANCHOR_REPLACEMENT = [
  ANCHOR_NEEDLE,
  `/** ${MARKER}: deployment switch for the browser-session gate below. */`,
  'const TRUST_REVERSE_PROXY_AUTH = /^(1|true|yes|on)$/iu.test(process.env.DSH_TRUST_REVERSE_PROXY_AUTH ?? "");',
  'const PROXY_AUTH_SECRET = process.env.DSH_PROXY_AUTH_SECRET ?? "";',
  'const PROXY_AUTH_HEADER = "x-dsh-proxy-auth";'
].join('\n')

// Gate: the first two lines of BrowserAuth.isAuthenticated. The inserted check
// runs before any cookie parsing, so it covers every caller — the index
// document (authorizeIndex) and every /api route (requestRejection).
const GATE_NEEDLE = ['\tisAuthenticated(request) {', '\t\tconst authority = requestAuthority(request.headers);'].join('\n')
const GATE_REPLACEMENT = [
  '\tisAuthenticated(request) {',
  `\t\t/* ${MARKER}: proxy-authenticated deployments skip the browser-session gate. */`,
  '\t\tif (TRUST_REVERSE_PROXY_AUTH) {',
  '\t\t\tif (PROXY_AUTH_SECRET === "") return true;',
  '\t\t\tconst presented = header(request.headers, PROXY_AUTH_HEADER);',
  '\t\t\tif (presented !== void 0 && tokenMatches(presented, PROXY_AUTH_SECRET)) return true;',
  '\t\t}',
  '\t\tconst authority = requestAuthority(request.headers);'
].join('\n')

function replaceOnce(text, needle, replacement, label) {
  const hits = text.split(needle).length - 1
  if (hits !== 1) {
    console.log(`WARN: ${label} needle matched ${hits} times, expected exactly 1 — skipping`)
    return undefined
  }
  return text.replace(needle, replacement)
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const prefix = args.find((arg) => !arg.startsWith('--'))
const root = resolve(prefix ?? process.cwd())
const target = resolve(root, TARGET)

console.log(`${checkOnly ? 'Checking' : 'Patching'} ${target}`)

if (!existsSync(target)) {
  console.log(`WARN: ${target} not found — is @deepseek-ai/dsh-client-connection installed there?`)
  process.exit(0)
}

const original = readFileSync(target, 'utf8')

if (original.includes(MARKER)) {
  console.log('Already patched (idempotency marker present), nothing to do')
  process.exit(0)
}

const withAnchor = replaceOnce(original, ANCHOR_NEEDLE, ANCHOR_REPLACEMENT, 'browser-auth constants')
if (withAnchor === undefined) process.exit(0)

const patched = replaceOnce(withAnchor, GATE_NEEDLE, GATE_REPLACEMENT, 'isAuthenticated gate')
if (patched === undefined) process.exit(0)

if (checkOnly) {
  console.log('Check passed: both needles match exactly once (--check wrote nothing)')
  process.exit(0)
}

writeFileSync(target, patched)
console.log(`Patched ${target}`)
console.log('Gate: DSH_TRUST_REVERSE_PROXY_AUTH=1 disables it; DSH_PROXY_AUTH_SECRET=<secret> requires header x-dsh-proxy-auth')
