/**
 * Static-asset caching patch for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   The dist server @deepseek-ai/dsh-host-frontend-static answers every asset
 *   with `content-type` and nothing else — no `cache-control`, no `etag`, no
 *   `last-modified`. The browser therefore cannot store or revalidate them and
 *   re-downloads the whole shell on every reload.
 *
 *   Measured on this deployment (2026-09-10, browser with an empty cache vs. an
 *   immediate second load, mobile-emulated profile):
 *     /assets/vendor-CCJJTK99.js   209,931 gzip / 740,575 decoded   no cache headers
 *     /assets/index-Df-65__b.js    161,865 gzip / 423,038 decoded   no cache headers
 *     both CSS bundles              18,678 gzip /  67,138 decoded   no cache headers
 *     -> 390 KB gzip re-fetched on EVERY reload; ~2.6 s of a warm reload on the
 *        simulated slow-4G profile, and the same bytes again on the phone.
 *   `/plugins/??...` already ships `cache-control: public, max-age=31536000,
 *   immutable` from dsh-client-modules, so only the dist path is missing it.
 *
 * What the patch does:
 *   In @deepseek-ai/dsh-host-frontend-static/lib/index.js `serveStatic` gains a
 *   cache policy: content-addressed paths (`/assets/...`, `/plugins/...`) become
 *   `public, max-age=31536000, immutable`; the HTML index keeps `no-cache` (its
 *   bytes are rendered per request with the boot injection table, so a
 *   revalidated index must never be reused); every other dist file gets
 *   `public, max-age=86400` plus a weak `etag` and `last-modified`, and answers
 *   `if-none-match` / `if-modified-since` with `304` — from a stat taken before
 *   the read, so a revalidation costs no file I/O. Non-files (`EISDIR` etc.)
 *   keep returning 404.
 *
 * Deliberately unchanged:
 *   - Authorization: `authorizeIndex` still runs before any index byte is read.
 *   - Body handling: the bytes handed to `res.end` are the same bytes as before.
 *   - Routing: the index path is still matched by resolved path.
 *
 * Contract (same as the other patches): exact needle replacement, single-match
 * guard, `WARN:` on drift, idempotency marker, exit code stays 0 — the
 * Dockerfile greps the output and fails the build on any `WARN:`.
 *
 * Usage: node static-cache-headers.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Adapted for the dsh-docker deployment (dsh 0.1.2-rc.1, bundle-verified
 * 2026-09-10). Re-verify the needles after any DSH version bump.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const MARKER = '/* dsh-docker:static-cache-headers */'

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
		join(root, 'node_modules', '@deepseek-ai', packageName, relative)
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1];
}
const target = locateBundle('dsh-host-frontend-static', join('lib', 'index.js'))

/** The bundle's own node:fs/promises import; extended with `stat`. */
const importNeedle = `import { readFile } from "node:fs/promises";`
const importReplacement = `import { readFile, stat } from "node:fs/promises";`

/**
 * Emitted validator expression, shared by the 200 and the 304 path so a stored
 * copy and a fresh copy can never disagree about the same file.
 */
const etagExpression = '`W/"${fileStats.size.toString(16)}-${Math.floor(fileStats.mtimeMs).toString(16)}"`'

/** Code appended after serveStatic: the cache policy and the conditional helper. */
const appendedHelpers = `${MARKER}
/** Directives for a content-addressed path: the name changes whenever the bytes do. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Revalidation-only policy for the per-request rendered index. */
const INDEX_CACHE_CONTROL = "no-cache";
/** Fallback policy for stable unhashed dist files (fonts, favicon, manifest). */
const STABLE_CACHE_CONTROL = "public, max-age=86400";
/** Index or content-addressed paths need no validator; the rest share one expression. */
function cacheControlFor(pathname) {
	if (pathname === "/" || pathname.endsWith("/") || pathname.endsWith(".html")) return INDEX_CACHE_CONTROL;
	if (pathname.startsWith("/assets/") || pathname.startsWith("/plugins/")) return IMMUTABLE_CACHE_CONTROL;
	return STABLE_CACHE_CONTROL;
}
/**
 * Validator headers for a stored stable file, or none for the two extremes.
 * @param pathname - decoded URL pathname of the request.
 * @param fileStats - stats of the served file, absent for the rendered index.
 * @returns the headers describing the stored entity.
 */
function cacheValidators(pathname, fileStats) {
	if (fileStats === void 0 || cacheControlFor(pathname) !== STABLE_CACHE_CONTROL) return {};
	return {
		etag: ${etagExpression},
		"last-modified": fileStats.mtime.toUTCString()
	};
}
/**
 * Whether a stored response may be answered with 304 for this request.
 * @param req - the incoming request carrying the conditional headers.
 * @param fileStats - stats of the file the request resolved to.
 * @returns true when the client's stored copy is still current.
 */
function isNotModified(req, fileStats) {
	const entityTag = ${etagExpression};
	const noneMatch = req.headers["if-none-match"];
	if (typeof noneMatch === "string" && noneMatch.split(",").some((candidate) => candidate.trim() === entityTag || candidate.trim() === "*")) return true;
	const modifiedSince = req.headers["if-modified-since"];
	if (typeof modifiedSince === "string" && noneMatch === void 0) {
		const since = Date.parse(modifiedSince);
		if (Number.isFinite(since)) return Math.floor(fileStats.mtimeMs / 1000) * 1000 <= since;
	}
	return false;
}`

/** The final write of serveStatic, which now carries the cache headers. */
const writeNeedle = `	res.writeHead(200, { "content-type": type });
	res.end(body);
}`
const writeReplacement = `	res.writeHead(200, {
		"content-type": type,
		"cache-control": cacheControlFor(pathname),
		...cacheValidators(pathname, fileStats)
	});
	res.end(body);
}
${appendedHelpers}`

/** The body read + content-type branch inside serveStatic's try block. */
const readNeedle = `		} else {
			body = await readFile(target);
			type = MIME[extname(target)] ?? "application/octet-stream";
		}`
const readReplacement = `		} else {
			fileStats = await stat(target).catch(() => void 0);
			if (fileStats !== void 0 && !fileStats.isFile()) {
				res.writeHead(404);
				res.end();
				return;
			}
			if (fileStats !== void 0 && isNotModified(req, fileStats)) {
				res.writeHead(304, {
					"cache-control": cacheControlFor(pathname),
					...cacheValidators(pathname, fileStats)
				});
				res.end();
				return;
			}
			body = await readFile(target);
			type = MIME[extname(target)] ?? "application/octet-stream";
		}`

/** Where the stat result is stored. */
const declarationNeedle = `	let body;
	let type;`
const declarationReplacement = `	let body;
	let type;
	let fileStats;`

/** The signature line of serveStatic, extended with the request for conditional asks. */
const signatureNeedle = `async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex) {`
const signatureReplacement = `async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex, req) {`

/** The fallback-seat call, which must pass the request through. */
const callNeedle = `		await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => ctx.connection.authorizeIndex(req, res), renderIndex);`
const callReplacement = `		await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => ctx.connection.authorizeIndex(req, res), renderIndex, req);`

const SEAMS = [
  ['fs import', importNeedle, importReplacement],
  ['body declaration', declarationNeedle, declarationReplacement],
  ['asset read', readNeedle, readReplacement],
  ['response write', writeNeedle, writeReplacement],
  ['serveStatic signature', signatureNeedle, signatureReplacement],
  ['fallback call', callNeedle, callReplacement],
]

if (!existsSync(target)) {
  console.log(`WARN: ${target} does not exist, skipping static cache patch`)
  console.log('Done: 0 dist server(s) patched')
  process.exit(0)
}

const text = readFileSync(target, 'utf8')
console.log(`Searching for the dist server response seams in ${target}...`)

if (text.includes(MARKER)) {
  console.log('Already patched (idempotency marker present), nothing to do')
  console.log('Done: 1 file verified')
  process.exit(0)
}

let ok = true
for (const [label, needle] of SEAMS) {
  const count = text.split(needle).length - 1
  if (count !== 1) {
    console.log(`WARN: Expected 1 "${label}" match in ${target}, found ${count}`)
    ok = false
  }
}
if (!ok) {
  console.log('WARN: static cache patch needles did not match exactly, skipping (stock headers stay in place)')
  console.log('Done: 0 dist server(s) patched')
  process.exit(0)
}

if (checkOnly) {
  console.log(`--check: all ${SEAMS.length} needles match exactly once in ${target}; patch would apply`)
  console.log('Done: 1 file verified (nothing written)')
  process.exit(0)
}

try {
  let patched = text
  for (const [, needle, replacement] of SEAMS) patched = patched.replace(needle, replacement)
  writeFileSync(target, patched)
  console.log(`Patched static cache policy into ${target}`)
  console.log('Done: 1 file patched')
} catch (err) {
  console.log(`WARN: Failed to patch ${target}: ${err.message}`)
  console.log('Done: 0 dist server(s) patched')
  process.exit(0)
}
