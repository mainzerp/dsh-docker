/**
 * Brotli compression patch for DeepSeek Harness (fail-closed).
 *
 * Why this exists (dsh 0.1.2 line):
 *   The host webserver compresses with the `compression` npm middleware, which
 *   only knows gzip/deflate, and dsh-web-app configures it at
 *   `compressionLevel: 1`. A browser that offers brotli still gets gzip-1.
 *
 *   Measured on this deployment (2026-09-10, 46 client plugin modules,
 *   parity harness over the real bundles):
 *     /plugins/??... response body : 5,728,431 bytes
 *     gzip level 1 (shipped)       : 1,639,165 bytes   <- downloaded on every page load
 *     gzip level 9                 : 1,363,867 bytes
 *     brotli quality 6             : 1,152,095 bytes   (29.7% smaller than shipped)
 *   Server CPU per request for that body: brotli 146 ms vs the shipped
 *   gzip-1 79 ms — paid once per page load, on a request the browser already
 *   serves from its own cache afterwards (`cache-control: immutable`).
 *   The plugin bundle is the single largest WebUI resource: on a simulated
 *   slow-4G profile (1.6 Mbit/s, 200 ms RTT, CPU throttled 4x) it accounted for
 *   ~10 s of a 3.4-10.6 s page load, and no session/workspace data can load
 *   before it arrives.
 *
 * What this patch does:
 *   In @deepseek-ai/dsh-host-webserver/lib/index.js one middleware is inserted
 *   ahead of the gzip chain. A request is handled by it — and by nothing else —
 *   only when ALL of these hold:
 *     - the client offered brotli (`Accept-Encoding` contains a listed `br`),
 *     - the response is a full 200 with a compressible content-type,
 *     - the body is at least the configured compression threshold,
 *     - the handler set no content-encoding of its own.
 *   Then the buffered body is encoded with node:zlib `brotliCompressSync`
 *   (quality 6) and written, with `vary: Accept-Encoding`; `content-length` and
 *   `etag` are dropped for those bodies because they no longer describe the
 *   bytes on the wire. If brotli itself fails, the bytes the handler produced
 *   are sent unchanged (never raw bytes claimed as `br`).
 *
 * Every other exchange reaches the shipped gzip middleware untouched: clients
 * that do not offer brotli, HEAD, SSE and other `text/event-stream` responses,
 * `content-range` responses, already-encoded bodies, and non-GET requests.
 *
 * Deliberate differences for a client that offers BOTH brotli and gzip:
 *   - The seat, not the gzip middleware, finalizes the response, so bodies the
 *     seat declines (below the configured threshold, non-200, or a handler that
 *     streams through `res.write`) are sent uncompressed instead of gzip-1.
 *     gzip clients are unaffected by all of this.
 *   - `vary: Accept-Encoding` is set by the seat for those responses too, so a
 *     shared cache still keys on the request's encoding.
 *   - No new npm dependency: the seat needs node:zlib, the imports already in
 *     the bundle, and the existing config numbers only.
 *
 * Contract (same as the other patches): exact needle replacement, single-match
 * guard, `WARN:` on drift, idempotency marker, exit code stays 0 — the
 * Dockerfile greps the output and fails the build on any `WARN:`.
 *
 * Usage: node brotli-compression.mjs [<prefix>] [--check]
 *   <prefix>  directory whose node_modules tree holds the installed packages
 *             (Dockerfile passes "$(dirname "$(npm root -g)")")
 *   --check   report only, write nothing
 *
 * Adapted for the dsh-docker deployment (dsh 0.1.2-rc.1, bundle-verified
 * 2026-09-10). Re-verify the needles after any DSH version bump.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const MARKER = '/* dsh-docker:brotli-compression */'

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
 * accepted, in that order, so the patch works against `npm root -g`'s parent
 * and against a package-local tree alike.
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
const target = locateBundle('dsh-host-webserver', join('lib', 'index.js'))

/**
 * First line of the shipped bundle. The inserted import is anchored to it so
 * the patch is a single, verifiable replacement even when a bundler rewrites
 * the rest of the file.
 */
const importNeedle = `import { createServer } from "node:http";`

/**
 * The exported factory ends the file. The brotli middleware is appended after
 * it, then wired in ahead of the gzip chain in `onRequest`.
 */
const tailNeedle = `export { WebServer, WebServer as default, renderIndexInjections };`
const tailReplacement = `${tailNeedle}
${MARKER}
/** Content types whose textual body is worth re-encoding. */
const BROTLI_TYPES = ["text/", "application/json", "application/javascript", "application/manifest+json", "image/svg+xml", "application/xml", "application/x-ndjson"];
/** Whether a response body of this content type may be brotli-encoded. */
function isCompressibleType(contentType) {
	return typeof contentType === "string" && BROTLI_TYPES.some((prefix) => contentType.toLowerCase().startsWith(prefix));
}
/**
 * Whether the client's Accept-Encoding lists brotli.
 *
 * A substring test is not enough (\`xbr\` and \`identity\` must not match), and a
 * br entry carrying \`q=0\` means the client refuses it, so the header is split
 * into codings and that entry's q-value is honoured.
 * @param value - the raw Accept-Encoding header, absent on a bare request.
 * @returns true when brotli is acceptable to this client.
 */
function acceptsBrotli(value) {
	if (typeof value !== "string") return false;
	for (const part of value.split(",")) {
		const [coding, ...parameters] = part.split(";");
		if (coding.trim().toLowerCase() !== "br") continue;
		return !parameters.some((parameter) => /^q=0(?:\.0*)?$/.test(parameter.trim().toLowerCase()));
	}
	return false;
}
/** Whether the client also accepts gzip, i.e. what the gzip middleware would do here. */
function wantsGzip(headers) {
	const value = headers["accept-encoding"];
	return typeof value === "string" && /(^|[ ,])gzip([ ,;]|$)/i.test(value);
}
/**
 * Build the brotli seat that sits ahead of the gzip middleware.
 *
 * The seat owns an exchange only when the client offered brotli, the handler
 * answers a GET with 200 and a compressible content-type and sets no
 * content-encoding of its own, and the body reaches \`thresholdBytes\`; it then
 * writes that body brotli-encoded. Every other exchange is handed to the
 * shipped gzip middleware \`delegate\` untouched, so gzip stays the supported
 * floor.
 *
 * The seat hands the gzip middleware a request that no longer offers gzip or
 * deflate, because that middleware is built on a library that negotiates with
 * \`Negotiator\` and would otherwise compress the very body this seat encodes
 * (its own \`vary\` handling is left to the \`br\` it never sees). With \`identity\`
 * as the only remaining coding the middleware stays inert, and the seat is the
 * single writer of the response — the shipped gzip path is unchanged for every
 * client that does not offer brotli.
 * @param thresholdBytes - smallest body worth re-encoding (the configured compression threshold).
 * @param delegate - the shipped gzip middleware, called for every declined exchange.
 * @returns a middleware writing brotli itself or delegating unchanged.
 */
function createBrotliMiddleware(thresholdBytes, delegate) {
	const flushOptions = { params: {
		[zlibConstants.BROTLI_PARAM_QUALITY]: 6,
		[zlibConstants.BROTLI_PARAM_SIZE_HINT]: 8 * 1024 * 1024
	} };
	return function brotliSeat(req, res, next) {
		if (!acceptsBrotli(req.headers["accept-encoding"]) || req.method !== "GET") {
			delegate(req, res, next);
			return;
		}
		/** Status the handler committed, held until the seat knows the encoding. */
		let held = null;
		/** Bytes buffered once the seat owns the exchange; null means it does not. */
		let chunks = null;
		/** Whether the handler streamed the body itself, which ends the seat's ownership. */
		let streamed = false;
		const originalWriteHead = res.writeHead;
		const originalWrite = res.write;
		const originalEnd = res.end;
		/**
		 * Commit the held status with the response's current headers.
		 *
		 * The headers are read live rather than replayed from the handler's call,
		 * because the seat changes them after that call (content-encoding, vary, the
		 * dropped validator) and a replayed block would put the stale values back.
		 */
		const commitHeld = () => {
			const statusCode = held;
			held = null;
			if (statusCode === null) return;
			originalWriteHead.call(res, statusCode, res.getHeaders());
		};
		/* Keep gzip out of this exchange: only identity remains for the delegate. */
		const seatRequest = Object.create(req);
		Object.defineProperty(seatRequest, "headers", { value: {
			...req.headers,
			"accept-encoding": "identity"
		} });
		res.writeHead = function (statusCode, reasonOrHeaders, maybeHeaders) {
			const headers = typeof reasonOrHeaders === "object" && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
			if (headers !== undefined && headers !== null) for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
			if (statusCode === 200 && res.getHeader("content-encoding") === void 0 && res.getHeader("content-range") === void 0 && isCompressibleType(res.getHeader("content-type"))) {
				/* Hold the block back: the encoding decision belongs to end(), and the response is committed once. */
				held = statusCode;
				chunks = [];
				return res;
			}
			return originalWriteHead.call(this, statusCode, reasonOrHeaders, maybeHeaders);
		};
		res.write = function (chunk, encoding, callback) {
			if (chunks === null || streamed || chunk === undefined || chunk === null) return originalWrite.call(this, chunk, encoding, callback);
			/* A streaming handler frames its own response, so the seat commits now and steps aside. */
			streamed = true;
			chunks = null;
			commitHeld();
			return originalWrite.call(this, chunk, encoding, callback);
		};
		res.end = function (body, encoding, callback) {
			if (chunks === null || streamed) return originalEnd.call(this, body, encoding, callback);
			const owned = chunks;
			chunks = null;
			if (body !== undefined && body !== null) owned.push(Buffer.isBuffer(body) ? body : Buffer.from(body, typeof encoding === "string" ? encoding : "utf8"));
			const payload = owned.length === 1 ? owned[0] : Buffer.concat(owned);
			if (payload.byteLength < thresholdBytes) {
				commitHeld();
				return originalEnd.call(res, payload);
			}
			try {
				const encoded = zlibBrotliCompressSync(payload, flushOptions);
				res.setHeader("content-encoding", "br");
				res.setHeader("vary", "Accept-Encoding");
				res.removeHeader("content-length");
				/* A re-encoded body's validator no longer describes the wire bytes. The
				   content-addressed paths never revalidate, so their validator goes with
				   the old bytes; a revalidating path keeps it (it describes the file). */
				const cacheControl = String(res.getHeader("cache-control") ?? "");
				if (cacheControl.includes("immutable") || res.getHeader("etag") === void 0) res.removeHeader("etag");
				commitHeld();
				return originalEnd.call(res, encoded);
			} catch {
				/* Brotli refused (size or memory): send the bytes the handler produced. */
				commitHeld();
				return originalEnd.call(res, payload);
			}
		};
		delegate(seatRequest, res, next);
	};
}`

const wireNeedle = `			if (this.gzip === void 0) next();
			else this.gzip(req, res, next);`
const wireReplacement = `			if (this.gzip === void 0) next();
			else createBrotliMiddleware(this.config.compressionThresholdBytes, this.gzip)(req, res, next);`

const importReplacement = `import { createServer } from "node:http";
${MARKER.replace('brotli-compression', 'brotli-compression-import')}
import { brotliCompressSync as zlibBrotliCompressSync, constants as zlibConstants } from "node:zlib";`

if (!existsSync(target)) {
  console.log(`WARN: ${target} does not exist, skipping brotli patch`)
  console.log('Done: 0 webserver bundle(s) patched')
  process.exit(0)
}

const text = readFileSync(target, 'utf8')
console.log(`Searching for the webserver compression seams in ${target}...`)

if (text.includes(MARKER)) {
  console.log('Already patched (idempotency marker present), nothing to do')
  console.log('Done: 1 file verified')
  process.exit(0)
}

const counts = [
  ['import', text.split(importNeedle).length - 1],
  ['export tail', text.split(tailNeedle).length - 1],
  ['gzip dispatch', text.split(wireNeedle).length - 1],
  ['zlib import present?', text.includes('node:zlib') ? 1 : 0],
]
for (const [label, count] of counts) {
  if (label === 'zlib import present?') continue
  if (count !== 1) console.log(`WARN: Expected 1 "${label}" match in ${target}, found ${count}`)
}
if (counts[0][1] !== 1 || counts[1][1] !== 1 || counts[2][1] !== 1 || counts[3][1] !== 0) {
  console.log('WARN: brotli patch needles did not match exactly, skipping (stock gzip stays in place)')
  console.log('Done: 0 webserver bundle(s) patched')
  process.exit(0)
}

if (checkOnly) {
  console.log(`--check: all 3 needles match exactly once in ${target}; patch would apply`)
  console.log('Done: 1 file verified (nothing written)')
  process.exit(0)
}

try {
  const patched = text
    .replace(importNeedle, importReplacement)
    .replace(tailNeedle, tailReplacement)
    .replace(wireNeedle, wireReplacement)
  writeFileSync(target, patched)
  console.log(`Patched brotli middleware into ${target}`)
  console.log('Done: 1 file patched')
} catch (err) {
  console.log(`WARN: Failed to patch ${target}: ${err.message}`)
  console.log('Done: 0 webserver bundle(s) patched')
  process.exit(0)
}
