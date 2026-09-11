/**
 * Preview-route auth gate for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   The browser-session gate is called from exactly two places: `authorizeIndex`
 *   (the index document) and `requestRejection` (the `/api` prefix route and the
 *   `/api/remote.mux` upgrade route). Every other path is public by design —
 *   `@deepseek-ai/dsh-host-frontend-static` says so verbatim ("Non-index assets
 *   stay public"), which is correct for hashed shell assets and client-module
 *   bundles, because they carry no session data.
 *
 *   A preview plugin (show_website) registers `kind: 'prefix'` routes under
 *   `/preview/<id>` whose handlers own the full response lifecycle and never
 *   consult the gate. Measured on this deployment (2026-09-11, dsh 0.1.2-rc.1):
 *   `GET /preview/<id>/` answers 200 to a request with no cookie and no token,
 *   and it does not even pass the Host/Origin trust fence — the same request with
 *   `Host: evil.example.com` also answers 200, while `/api/...` with that host
 *   answers 403. Over a reverse-proxy deployment with
 *   `DSH_TRUST_REVERSE_PROXY_AUTH=1` (this image's documented remote-access mode)
 *   the index gate is off as well, so such a deployment exposes the whole WebUI
 *   plus every published preview to anyone who can reach the port.
 *
 *   A preview is not shell baggage: it serves the agent's own content, and in
 *   proxy mode it forwards arbitrary methods and WebSocket upgrades to any HTTP
 *   origin the container can reach. It therefore belongs behind the same gate as
 *   `/api`.
 *
 * What this patch does:
 *   In @deepseek-ai/dsh-host-webserver/lib/index.js the HTTP dispatch gains one
 *   check ahead of route dispatch, and the `upgrade` listener gains the same
 *   check ahead of its exact-path lookup. A request whose pathname looks like a
 *   preview (`/preview/<id>`, one segment — the shape `normalizeMountPath`
 *   allows) AND for which the server's own `match()` returns a `prefix` route is
 *   answered from the connection service's verdict:
 *
 *     `ctx.get('connection').requestRejection(req)`
 *
 *   undefined -> the request continues into the preview route unchanged;
 *   401/403   -> the same minimal response the `/api` route sends ("unauthorized"
 *                / "forbidden"; upgrades get the api-gateway's `rejectRemoteStreamUpgrade`
 *                wire format, so a WebSocket client sees a clean HTTP rejection);
 *   no connection service -> 503, never a pass (this gate has no open mode).
 *
 *   With no preview route registered nothing is gated, so a stock deployment
 *   without a preview plugin behaves exactly as before. `/preview` is a reserved
 *   application prefix: `normalizeMountPath` enforces it, and no dsh package
 *   registers a route there (only `/api`, `/plugins` and the fallback exist).
 *
 * Interaction with patches/trusted-proxy-auth.mjs:
 *   That patch narrows `BrowserAuth.isAuthenticated` for proxy-authenticated
 *   deployments; this one only decides WHICH requests consult it. Both stay
 *   independent: with `DSH_TRUST_REVERSE_PROXY_AUTH=1` and no secret, previews
 *   are reachable exactly like `/api` (the proxy is the authentication); with the
 *   flag unset, previews need the launch-token cookie like the rest of the UI.
 *
 * Contract (same as the other patches): exact needle replacement, single-match
 * guards, a static check of every injected file, `WARN:` on drift, idempotency
 * marker, exit code stays 0 — the Dockerfile greps the output and fails the build
 * on any `WARN:`.
 *
 * Usage: node preview-auth-gate.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Verified against dsh 0.1.2-rc.1 (2026-09-11) in the global install layout
 * (`<prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/...`).
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PACKAGE = 'dsh-host-webserver'
const MARKER = 'dsh-docker:preview-auth-gate'
const RELATIVE = join('lib', 'index.js')

/** Resolve one bundle inside the installed dsh tree (mirrors the sibling patches). */
function locateBundle(packageName, relative) {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', packageName, relative),
    join(root, 'node_modules', '@deepseek-ai', packageName, relative)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]
}

// Gate helper. Inserted ahead of the Server class so the dispatch below can call
// it; the regex is the shape the preview plugin's own normalizeMountPath allows
// (exactly one segment, letters/digits/dot/dash/underscore).
const HELPERS = `/* ${MARKER}: preview mounts own their whole response, so the connection gate never sees
   them. They serve agent-authored content (and, in proxy mode, forward arbitrary methods and
   WebSocket upgrades), so they are held to the same verdict as the /api route. There is no open
   mode: a deployment without the connection service still refuses instead of serving.
   A path is a preview only when <webserver>.match() actually returns a PREFIX route for it, so an
   exactly registered route under /preview/ (another plugin's) keeps its own rules. */
function previewMount(matcher, pathname) {
	if (!/^\\/preview\\/[A-Za-z0-9._-]+(?:\\/|$)/u.test(pathname)) return false;
	const matched = matcher.match(pathname);
	return matched !== void 0 && matched.kind === "prefix";
}
function previewGateRejection(ctx, req) {
	const connection = ctx.get("connection");
	if (connection === void 0) return 503;
	const rejection = connection.requestRejection(req);
	return rejection === void 0 ? void 0 : rejection;
}
function rejectPreviewRequest(res, status) {
	res.writeHead(status, { "cache-control": "no-store" });
	res.end(status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "auth service unavailable");
}
function rejectPreviewUpgrade(socket, status) {
	try {
		const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable";
		const body = reason.toLowerCase();
		socket.end([
			\`HTTP/1.1 \${String(status)} \${reason}\`,
			"Connection: close",
			"Content-Type: text/plain; charset=utf-8",
			\`Content-Length: \${String(Buffer.byteLength(body))}\`,
			"",
			body
		].join("\\r\\n"));
	} catch {
		socket.destroy();
	}
}
`

// Anchor: the service class declaration. Stable, tab-free, unique in the bundle;
// the helpers must sit above it so the dispatch below can call them.
const ANCHOR_NEEDLE = 'var WebServer = class extends Service {'

// HTTP dispatch: the named-route hit, immediately before the handler runs.
// Tab-indented (the bundle is tab-formatted); unique — `this.match(` has exactly
// one call site.
const DISPATCH_NEEDLE = [
	'\t\t\tconst route = this.match(rawPath);',
	'\t\t\tif (route !== void 0) {',
	'\t\t\t\tawait route.handler(req, res);'
].join('\n')

const DISPATCH_REPLACEMENT = [
	'\t\t\tconst route = this.match(rawPath);',
	`\t\t\t/* ${MARKER}: a preview prefix route answers without consulting the browser gate. */`,
	'\t\t\tif (route !== void 0 && route.kind === "prefix" && previewMount(this, rawPath)) {',
	'\t\t\t\tconst rejection = previewGateRejection(this.ctx, req);',
	'\t\t\t\tif (rejection !== void 0) {',
	'\t\t\t\t\trejectPreviewRequest(res, rejection);',
	'\t\t\t\t\treturn;',
	'\t\t\t\t}',
	'\t\t\t}',
	'\t\t\tif (route !== void 0) {',
	'\t\t\t\tawait route.handler(req, res);'
].join('\n')

// Upgrade dispatch: the exact-path lookup, immediately before it. Also
// tab-indented; unique — `this.upgrades.get(` has exactly one call site.
const UPGRADE_NEEDLE = '\t\t\t\troute = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);'

const UPGRADE_REPLACEMENT = [
	`\t\t\t\t/* ${MARKER}: the same gate for WebSocket upgrades (vite HMR, live previews). */`,
	'\t\t\t\tconst pathname = new URL(req.url ?? "/", "http://x").pathname;',
	'\t\t\t\tif (previewMount(this, pathname)) {',
	'\t\t\t\t\tconst rejection = previewGateRejection(this.ctx, req);',
	'\t\t\t\t\tif (rejection !== void 0) {',
	'\t\t\t\t\t\trejectPreviewUpgrade(socket, rejection);',
	'\t\t\t\t\t\treturn;',
	'\t\t\t\t\t}',
	'\t\t\t\t}',
	'\t\t\t\troute = this.upgrades.get(pathname);'
].join('\n')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const prefix = args.find((arg) => !arg.startsWith('--'))
const root = resolve(prefix ?? process.cwd())

const target = locateBundle(PACKAGE, RELATIVE)
if (!existsSync(target)) {
  console.log(`WARN: ${PACKAGE} bundle not found at ${target}`)
  console.log('Done: 0 bundle(s) patched')
  process.exit(0)
}

let text = readFileSync(target, 'utf8')

if (text.includes(MARKER)) {
  console.log(`Already patched: ${target}`)
  console.log('Done: 1 bundle already carried the gate')
  process.exit(0)
}

const needles = [
  ['anchor', ANCHOR_NEEDLE],
  ['dispatch', DISPATCH_NEEDLE],
  ['upgrade', UPGRADE_NEEDLE]
]

const counts = needles.map(([label, needle]) => [label, text.split(needle).length - 1])
const drifted = counts.filter(([, count]) => count !== 1)
if (drifted.length > 0) {
  console.log(`WARN: ${PACKAGE} needle drift (${drifted.map(([label, count]) => `${label}=${String(count)}`).join(', ')}), skipping`)
  console.log('Done: 0 bundle(s) patched')
  process.exit(0)
}

const patched = text
  .replace(ANCHOR_NEEDLE, `${HELPERS}${ANCHOR_NEEDLE}`)
  .replace(DISPATCH_NEEDLE, DISPATCH_REPLACEMENT)
  .replace(UPGRADE_NEEDLE, UPGRADE_REPLACEMENT)

if (!patched.includes('previewMount(this, rawPath)') || !patched.includes('previewMount(this, pathname)')) {
  console.log('WARN: preview auth gate replacement did not land in both dispatch paths, skipping')
  console.log('Done: 0 bundle(s) patched')
  process.exit(0)
}

// The injected text must still parse. `node --check` on a copy with the .mjs
// extension (the bundle is ESM and carries dynamic import), so a malformed
// replacement fails the build instead of shipping a WebUI that cannot boot.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-preview-gate-'))
try {
  const copy = join(scratch, 'bundle.mjs')
  writeFileSync(copy, patched)
  const check = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.log(`WARN: patched ${PACKAGE} does not parse: ${(check.stderr || check.stdout || '').trim().split('\n')[0]}`)
    console.log('Done: 0 bundle(s) patched')
    process.exit(0)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (checkOnly) {
  console.log(`--check: all ${String(needles.length)} needles match exactly once in ${target}; patch would apply`)
  console.log('Done: 1 file verified (nothing written)')
  process.exit(0)
}

try {
  writeFileSync(target, patched)
  console.log(`Patched preview auth gate into ${target}`)
  console.log('Done: 1 bundle patched')
} catch (err) {
  console.log(`WARN: Failed to patch ${target}: ${err.message}`)
  console.log('Done: 0 bundle(s) patched')
  process.exit(0)
}
