/**
 * show-website — host plugin (persistent).
 *
 * Publishes a local page or a server running inside the DSH container on the
 * DSH web origin under /preview/<id>/ so the human browser can reach it.
 * Static directories come from the fs service; a running server is
 * reverse-proxied through a short-lived node relay child (subprocess),
 * WebSocket upgrades included.
 *
 * Installed through the profile patch layer:
 *   /data/profiles/web/cordis.patch.yml -> insert row id: show-website
 * Source of truth for the dynamic Cordis package webpub-1 as well.
 */

export const name = 'show-website'
export const inject = ['tools', 'webServer']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf'
}

const REWRITABLE = /^(text\/html|text\/css)/
const MAX_BYTES = 64 * 1024 * 1024

// One connection of raw byte relay: the host half has no HTTP client, so a
// short-lived node child owns the socket to the upstream server and the host
// half pipes request bytes in and response bytes out.
const RELAY_SOURCE = "const net=require('node:net');" +
  "const host=process.argv[1];const port=Number(process.argv[2]);" +
  "const up=net.connect(port,host);" +
  "up.on('connect',()=>{process.stdin.pipe(up,{end:false});up.pipe(process.stdout,{end:false})});" +
  "up.on('error',(error)=>{const crlf=String.fromCharCode(13,10);const text='preview upstream unreachable: '+(error&&error.message?error.message:String(error));const head='HTTP/1.1 502 Bad Gateway'+crlf+'content-type: text/plain; charset=utf-8'+crlf+'connection: close'+crlf+'content-length: '+Buffer.byteLength(text)+crlf+crlf;try{process.stdout.write(head+text)}catch(e){}process.exitCode=1});" +
  "up.on('close',()=>{try{process.stdout.end()}catch(e){}});" +
  "process.stdout.on('finish',()=>{process.exit(process.exitCode||0)});" +
  "process.stdin.on('error',()=>{});" +
  "process.stdout.on('error',()=>{process.exit(0)});"

function slugify(value) {
  const cleaned = String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '').replace(/[-._]+$/, '')
  return cleaned.slice(0, 40)
}

function mimeOf(filePath) {
  const at = String(filePath).lastIndexOf('.')
  if (at === -1) return 'application/octet-stream'
  return MIME[String(filePath).slice(at).toLowerCase()] || 'application/octet-stream'
}

function rawPathOf(url) {
  const value = typeof url === 'string' && url !== '' ? url : '/'
  const at = value.indexOf('?')
  return at === -1 ? value : value.slice(0, at)
}

function decodePath(value) {
  try { return decodeURIComponent(value) } catch (error) { return value }
}

function joinPath(base, relative) {
  const segments = String(String(base) + '/' + String(relative)).split('/')
  const out = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  return '/' + out.join('/')
}

// Static previews live under a sub-path, so root-absolute URLs in markup
// (/assets/...) must be re-anchored or every asset would 404.
function rewriteRootUrls(text, prefix) {
  return String(text)
    .replace(/((?:href|src|poster|action)\s*=\s*")\/(?!\/)/gi, '$1' + prefix + '/')
    .replace(/((?:href|src|poster|action)\s*=\s*')\/(?!\/)/gi, '$1' + prefix + '/')
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, 'url($1' + prefix + '/')
}

function normalizeMountPath(raw) {
  let value = String(raw).trim()
  if (value.charAt(0) !== '/') value = '/' + value
  while (value.length > 1 && value.charAt(value.length - 1) === '/') value = value.slice(0, -1)
  if (!/^\/preview\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('path must look like /preview/<name> using letters, digits, dot, dash or underscore')
  }
  return value
}

function parseTarget(raw) {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(String(raw).trim())
  if (match === null) throw new Error('target must look like http://127.0.0.1:5273')
  if (match[1].toLowerCase() !== 'http') {
    throw new Error('only plain http:// targets are supported; the target must be reachable from inside the DSH container')
  }
  const authority = match[2]
  const tail = match[3] === '' ? '/' : match[3]
  if (tail !== '/') throw new Error('target must be a bare origin without a path, e.g. http://127.0.0.1:5273')
  let host = authority
  let port = 80
  const colon = authority.lastIndexOf(':')
  if (colon > authority.lastIndexOf(']')) {
    host = authority.slice(0, colon)
    port = Number(authority.slice(colon + 1))
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('target port is invalid')
  return { host, port, authority }
}

function normalizeOrigin(raw) {
  const value = String(raw).trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/?#]+$/.test(value)) {
    throw new Error('origin must look like https://dsh.example.net (scheme and host, no path)')
  }
  return value
}

function firstHeaderValue(value) {
  if (typeof value === 'string') return value.split(',')[0].trim()
  if (Array.isArray(value) && value.length > 0) return String(value[0]).split(',')[0].trim()
  return ''
}

function isLoopbackHost(host) {
  const value = String(host).toLowerCase()
  return value.indexOf('127.0.0.1') === 0 || value.indexOf('localhost') === 0 || value.indexOf('[::1]') === 0 || value.indexOf('0.0.0.0') === 0
}

export function apply(ctx) {
    const webServer = ctx.webServer
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const mounts = []
    const state = { origin: '' }
    let seq = 0
    let nodeBinary = 'node'

    // The browser may reach DSH through a TLS-terminating reverse proxy, so the
    // public origin is learned from real forwarded requests instead of being
    // guessed from the local listen address. A loopback request never
    // overwrites an already known public origin.
    const rememberOrigin = (req) => {
      try {
        const headers = req.headers || {}
        const host = firstHeaderValue(headers['x-forwarded-host']) || firstHeaderValue(headers.host)
        if (host === '') return
        if (isLoopbackHost(host) && state.origin !== '' && isLoopbackHost(state.origin.replace(/^https?:\/\//, '')) !== true) return
        let proto = firstHeaderValue(headers['x-forwarded-proto'])
        if (proto !== 'http' && proto !== 'https') proto = 'http'
        const origin = proto + '://' + host
        if (origin !== state.origin) {
          state.origin = origin
          console.log('show_website: public origin ' + origin)
        }
      } catch (error) { /* request headers unavailable */ }
    }

    if (subprocess !== undefined) {
      try {
        Promise.resolve(subprocess.resolveExecutable('node')).then((resolved) => {
          if (typeof resolved === 'string' && resolved !== '') nodeBinary = resolved
        }, () => {})
      } catch (error) { /* keep the bare executable name */ }
    }

    const localOrigin = () => {
      try {
        const host = String(webServer.host) === '0.0.0.0' ? '127.0.0.1' : String(webServer.host)
        return 'http://' + host + ':' + String(webServer.port)
      } catch (error) { return '' }
    }

    const findMount = (key) => mounts.find((mount) => mount.id === key || mount.path === key || mount.path + '/' === key)

    const closeMount = (mount) => {
      const at = mounts.indexOf(mount)
      if (at !== -1) mounts.splice(at, 1)
      const disposers = mount.disposers
      mount.disposers = []
      for (const dispose of disposers) {
        try { dispose() } catch (error) { console.error('show_website: could not remove a route', error) }
      }
    }

    const send = (res, status, text) => {
      try {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      } catch (error) { try { res.destroy() } catch (ignored) { /* socket already gone */ } }
    }

    const inspect = async (path) => {
      try {
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        return { target, info }
      } catch (error) { return undefined }
    }

    const spawnRelay = (mount) => subprocess.spawn({
      argv: [nodeBinary, '-e', RELAY_SOURCE, mount.target.host, String(mount.target.port)],
      cwd: '/tmp',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 1000
    })

    const buildHead = (req, mount, upgrading) => {
      let target = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
      if (mount.strip === true && target.indexOf(mount.path) === 0) {
        target = target.slice(mount.path.length)
        if (target === '') target = '/'
        else if (target.charAt(0) === '?') target = '/' + target
      }
      let head = String(req.method || 'GET') + ' ' + target + ' HTTP/1.1\r\n'
      const raw = req.rawHeaders || []
      for (let index = 0; index + 1 < raw.length; index += 2) {
        const name = String(raw[index])
        const lower = name.toLowerCase()
        if (lower === 'host') continue
        if (upgrading !== true && (lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection')) continue
        head += name + ': ' + String(raw[index + 1]) + '\r\n'
      }
      head += 'Host: ' + mount.target.authority + '\r\n'
      if (upgrading !== true) head += 'Connection: close\r\n'
      head += '\r\n'
      return head
    }

    // The upstream response is written to the client socket byte for byte, so
    // chunked framing and websocket handshakes need no re-encoding.
    const handleProxy = (req, res, mount) => {
      rememberOrigin(req)
      const socket = res.socket
      if (socket === undefined) { send(res, 500, 'no client socket'); return }
      let child
      try {
        child = spawnRelay(mount)
      } catch (error) {
        send(res, 502, 'preview relay could not start: ' + (error && error.message ? error.message : String(error)))
        return
      }
      mount.hits += 1
      let done = false
      const finish = () => {
        if (done) return
        done = true
        try { socket.end() } catch (error) { /* already closed */ }
      }
      const abort = () => {
        if (done) return
        done = true
        try { child.terminate() } catch (error) { /* already exited */ }
        try { socket.destroy() } catch (error) { /* already closed */ }
      }
      try {
        child.stdout.on('data', (chunk) => { if (done !== true) { try { socket.write(chunk) } catch (error) { abort() } } })
        child.stdout.on('end', finish)
        child.stdout.on('close', finish)
        child.done.then(finish, finish)
        socket.on('close', abort)
        socket.on('error', abort)
        req.on('error', abort)
        child.stdin.write(buildHead(req, mount, false))
        // Never end the relay's stdin: a half-closed upstream socket makes dev
        // servers abort the request before answering. The upstream's
        // Connection: close ends the exchange instead.
        req.on('data', (chunk) => { if (done !== true) { try { child.stdin.write(chunk) } catch (error) { abort() } } })
      } catch (error) {
        abort()
        console.error('show_website: proxy request failed', error)
      }
    }

    const handleUpgrade = (req, socket, head, mount) => {
      rememberOrigin(req)
      let child
      try {
        child = spawnRelay(mount)
      } catch (error) {
        console.error('show_website: websocket relay could not start', error)
        try { socket.destroy() } catch (ignored) { /* already closed */ }
        return
      }
      let done = false
      const abort = () => {
        if (done) return
        done = true
        try { child.terminate() } catch (error) { /* already exited */ }
        try { socket.destroy() } catch (error) { /* already closed */ }
      }
      try {
        child.stdout.on('data', (chunk) => { if (done !== true) { try { socket.write(chunk) } catch (error) { abort() } } })
        child.stdout.on('end', () => { try { socket.end() } catch (error) { /* already closed */ } })
        child.done.then(() => { try { socket.end() } catch (error) { /* already closed */ } }, () => {})
        socket.on('close', abort)
        socket.on('error', abort)
        child.stdin.write(buildHead(req, mount, true))
        if (head !== undefined && head !== null && head.length > 0) child.stdin.write(head)
        socket.pipe(child.stdin)
      } catch (error) {
        abort()
        console.error('show_website: websocket relay failed', error)
      }
    }

    const handleStatic = async (req, res, mount) => {
      rememberOrigin(req)
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'method not allowed'); return }
      const requestPath = decodePath(rawPathOf(req.url))
      if (requestPath === mount.path) {
        res.writeHead(302, { location: mount.path + '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (requestPath.indexOf(mount.path + '/') !== 0) { send(res, 404, 'not found'); return }
      const relative = requestPath.slice(mount.path.length)
      let found
      if (mount.rootIsFile === true) {
        if (relative !== '/' && relative !== '') { send(res, 404, 'not found'); return }
        found = await inspect(fs.processPath(mount.rootTarget))
      } else {
        found = await inspect(joinPath(fs.processPath(mount.rootTarget), relative))
        if (found !== undefined && found.info !== undefined && found.info.type === 'directory') {
          found = await inspect(joinPath(fs.processPath(found.target), 'index.html'))
        }
        if ((found === undefined || found.info === undefined || found.info.type !== 'file') && mount.spa === true && mount.indexTarget !== undefined) {
          found = await inspect(fs.processPath(mount.indexTarget))
        }
      }
      if (found === undefined || found.info === undefined || found.info.type !== 'file') { send(res, 404, 'not found'); return }
      if (fs.contains(mount.rootTarget, found.target) !== true) { send(res, 403, 'forbidden'); return }
      const bytes = await fs.readBytes(found.target, undefined, MAX_BYTES)
      const type = mimeOf(fs.processPath(found.target))
      let body = bytes
      if (REWRITABLE.test(type)) {
        body = new TextEncoder().encode(rewriteRootUrls(new TextDecoder('utf-8').decode(bytes), mount.path))
      }
      const headers = { 'content-type': type, 'cache-control': 'no-store' }
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
      headers['content-length'] = String(body.length)
      res.writeHead(200, headers)
      res.end(body)
    }

    const openMount = async (args) => {
      const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
      const targetSpec = typeof args.target === 'string' ? args.target.trim() : ''
      if ((dir === '') === (targetSpec === '')) {
        throw new Error('pass exactly one of "dir" (local file or directory) or "target" (http://host:port of a running server)')
      }
      let id = typeof args.id === 'string' && args.id.trim() !== '' ? slugify(args.id) : ''
      if (id === '') { seq += 1; id = 'preview-' + String(seq) }
      const mountPath = normalizeMountPath(typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '/preview/' + id)
      const previous = mounts.find((mount) => mount.path === mountPath)
      if (previous !== undefined) closeMount(previous)
      const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : id

      if (dir !== '') {
        if (fs === undefined) throw new Error('the filesystem service is unavailable, so local files cannot be served')
        const root = await inspect(dir)
        if (root === undefined || root.info === undefined) throw new Error('path does not exist: ' + dir)
        if (root.info.type !== 'file' && root.info.type !== 'directory') throw new Error('path is neither a file nor a directory: ' + dir)
        const rootIsFile = root.info.type === 'file'
        const index = rootIsFile === true ? root : await inspect(joinPath(fs.processPath(root.target), 'index.html'))
        const mount = {
          id,
          path: mountPath,
          mode: 'dir',
          title,
          rootTarget: root.target,
          rootIsFile,
          indexTarget: index === undefined ? undefined : index.target,
          spa: args.spa === true,
          hits: 0,
          disposers: []
        }
        mount.handler = (req, res) => {
          handleStatic(req, res, mount).catch((error) => {
            console.error('show_website: static preview failed', error)
            send(res, 500, 'preview failed: ' + (error && error.message ? error.message : String(error)))
          })
        }
        mount.disposers.push(webServer.register({ kind: 'prefix', path: mountPath, handler: mount.handler }))
        mounts.push(mount)
        return mount
      }

      if (subprocess === undefined) throw new Error('the subprocess service is unavailable, so a running server cannot be proxied')
      const target = parseTarget(targetSpec)
      const mount = {
        id,
        path: mountPath,
        mode: 'proxy',
        title,
        target,
        strip: args.strip_prefix === true,
        hits: 0,
        disposers: []
      }
      mount.handler = (req, res) => {
        try { handleProxy(req, res, mount) } catch (error) {
          console.error('show_website: proxy failed', error)
          send(res, 502, 'preview failed: ' + (error && error.message ? error.message : String(error)))
        }
      }
      mount.disposers.push(webServer.register({ kind: 'prefix', path: mountPath, handler: mount.handler }))
      try {
        mount.disposers.push(webServer.registerUpgrade({
          path: mountPath + '/',
          handler: (req, socket, head) => { handleUpgrade(req, socket, head, mount) }
        }))
      } catch (error) {
        console.error('show_website: websocket route for ' + mountPath + ' was not registered', error)
      }
      mounts.push(mount)
      return mount
    }

    const describeMount = (mount) => {
      const link = mount.path + '/'
      const origin = state.origin !== '' ? state.origin : localOrigin()
      const described = {
        id: mount.id,
        path: mount.path,
        link,
        url: origin === '' ? link : origin + link,
        mode: mount.mode,
        title: mount.title
      }
      if (origin !== '') described.origin = origin
      if (mount.mode === 'dir') {
        described.root = fs.processPath(mount.rootTarget)
        described.source = 'static files from ' + described.root
        described.note = mount.spa === true
          ? 'Unknown paths fall back to index.html.'
          : 'Root-absolute URLs in HTML/CSS are rewritten to ' + mount.path + '/.'
      } else {
        described.target = 'http://' + mount.target.authority
        described.strip_prefix = mount.strip === true
        described.source = 'reverse proxy to ' + described.target
        described.note = mount.strip === true
          ? 'The mount path is stripped before forwarding, so the upstream serves at its own root.'
          : 'The full path is forwarded, so the upstream must serve under ' + mount.path + '/ (vite: --base=' + mount.path + '/).'
      }
      return described
    }

    ctx.effect(() => () => {
      for (const mount of mounts.slice()) closeMount(mount)
    }, 'show-website: preview mounts')

    const tool = {
      name: 'show_website',
      description: 'Publish a web page on the DSH server itself so the human can actually open it in their browser. DSH runs inside a container: a web server the agent starts on its own port (vite, python -m http.server, a preview script, ...) is NOT reachable from the human browser, but the DSH port is. This tool mounts a page under /preview/<id>/ on the DSH origin and returns the link to hand to the human. Two modes: dir (absolute path of a local file or directory served statically) and target (http://host:port of a server already running inside the container, reverse-proxied including WebSocket upgrades so vite HMR keeps working). For a dev server that emits root-absolute URLs, start it with a base equal to the mount path (vite --base=/preview/game/ --port 5273) and call this tool with id "game" and target "http://127.0.0.1:5273"; for a server that serves at its own root pass strip_prefix true. The returned url is relative to the DSH origin unless the public origin is known — pass origin explicitly (e.g. https://dsh.example.net) or it is learned from X-Forwarded-* headers once the human opens a preview — and present it to the human as a Markdown link.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'close', 'list'], description: 'open (default) publishes a page; close removes a mount; list reports the current mounts.' },
          id: { type: 'string', description: 'Short stable name for the mount; the default path is /preview/<id>/. Reusing an id replaces the existing mount.' },
          path: { type: 'string', description: 'Explicit mount path starting with /preview/. Defaults to /preview/<id>/.' },
          dir: { type: 'string', description: 'Absolute path of a local file or directory to serve statically.' },
          target: { type: 'string', description: 'http://host:port of a server already running inside the container to reverse-proxy, WebSocket upgrades included.' },
          strip_prefix: { type: 'boolean', description: 'Proxy only: strip the mount path before forwarding. true for servers that serve at their own root (python -m http.server, vite without --base); default false suits vite started with --base=<mount path>/.' },
          spa: { type: 'boolean', description: 'Static only: fall back to index.html for unknown paths. Default false.' },
          title: { type: 'string', description: 'Human-readable label for the preview.' },
          origin: { type: 'string', description: 'Public origin the human uses to reach this DSH, e.g. https://dsh.example.net. Recorded and used to build absolute preview links; also learned automatically from X-Forwarded-* headers once a preview is opened.' }
        }
      },
      output: {
        schema: {},
        render(_args, value) {
          if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
          if (value.action === 'list') {
            const list = Array.isArray(value.mounts) ? value.mounts : []
            if (list.length === 0) return [{ type: 'text', text: 'No website preview is published right now.' }]
            return [{ type: 'text', text: 'Published previews:\n' + list.map((mount) => '- ' + (mount.url === undefined ? mount.link : mount.url) + '  (' + mount.source + ')').join('\n') }]
          }
          if (value.action === 'close') return [{ type: 'text', text: 'Removed the preview at ' + String(value.path) + '.' }]
          const url = value.url === undefined ? String(value.link) : String(value.url)
          return [{
            type: 'text',
            text: 'Website published: ' + url + '\n' +
              'Open it in the browser: [' + String(value.title) + '](' + url + ')\n' +
              String(value.source) + (value.note === undefined ? '' : '\n' + String(value.note))
          }]
        }
      },
      async execute(args) {
        const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'open'
        if (typeof args.origin === 'string' && args.origin.trim() !== '') state.origin = normalizeOrigin(args.origin)
        if (action === 'list') return { action: 'list', mounts: mounts.map(describeMount) }
        if (action === 'close') {
          const key = typeof args.id === 'string' && args.id.trim() !== ''
            ? args.id.trim()
            : (typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '')
          if (key === '') throw new Error('close needs an id or a path')
          const mount = findMount(key)
          if (mount === undefined) throw new Error('no preview is mounted as "' + key + '"')
          const removed = { action: 'close', id: mount.id, path: mount.path }
          closeMount(mount)
          return removed
        }
        if (action !== 'open') throw new Error('action must be "open", "close" or "list"')
        const mount = await openMount(args)
        const described = describeMount(mount)
        described.action = 'open'
        return described
      }
    }
    ctx.tools.register(tool)
}
