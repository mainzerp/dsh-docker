# dsh-docker

Docker deployment for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) with access through the WebUI.

> **Note:** This project is "vibe coded" — the code was written iteratively with AI assistance.

## Quickstart

```sh
cp .env.example .env   # set DEEPSEEK_API_KEY and, if needed, TRUSTED_HOSTS
docker compose up -d --build
```

Since 0.1.2 the WebUI requires a per-launch token — a bare
`http://localhost:3080` returns 401. Get the authenticated URL from the
container logs and open one of the `dsh web (external):` lines:

```sh
docker compose logs dsh | grep 'dsh web'
```

Behind an authenticating reverse proxy this gate can be replaced by the proxy
instead (`DSH_TRUST_REVERSE_PROXY_AUTH`) — see
[Auth behind an authenticating reverse proxy](#auth-behind-an-authenticating-reverse-proxy).

All runtime variables (see `.env.example`) are passed through from the shell
environment as well as from `.env` (`GH_TOKEN=... docker compose up -d`);
a variable set in neither place is omitted from the container entirely. Env
changes require recreating the container
(`docker compose up -d --force-recreate`) — `restart` does not re-read them.

### Prebuilt image

To skip the local build and use the image published to GHCR instead:

```sh
docker compose -f compose.prebuilt.yaml up -d
```

The prebuilt image is `ghcr.io/mainzerp/dsh-docker` (tags: `latest`, `x.y`, `x.y.z`,
built on every release). Version pinning works via the image tag — the `DSH_VERSION` /
`GH_VERSION` / `PLAYWRIGHT_VERSION` / `UV_VERSION` build args only apply to the local
build in `compose.yaml`.

A scheduled workflow (`.github/workflows/dsh-update.yml`, daily) rebuilds the image
automatically when a new `@deepseek-ai/dsh` version appears on npm (the `latest`
dist-tag tracks the release channel), publishing
`latest` + `dsh-<version>` tags (e.g. `dsh-0.1.2-rc.1`). Pin to a specific dsh
version via `image: ghcr.io/mainzerp/dsh-docker:dsh-<version>` in
`compose.prebuilt.yaml`; `latest` always tracks the newest dsh release.

## LAN access

`dsh web` intentionally binds only to `127.0.0.1` (the CLI rejects `--host 0.0.0.0`).
The container therefore runs dsh internally on `127.0.0.1:3081` and forwards
`0.0.0.0:3080 -> 127.0.0.1:3081` via socat.

The `/api` endpoint also enforces a browser trust fence: requests via a LAN IP or
hostname are only accepted if the authority is allowed through `--trusted-host`.
Set `TRUSTED_HOSTS` in `.env` (comma-separated, with port):

```
TRUSTED_HOSTS=192.168.1.10:3080,myserver:3080
```

Then run `docker compose up -d` again. The launch token survives authority
rewriting (the minted cookie binds to the authority the browser used), so use
the `dsh web (external):` URL the entrypoint prints for each `TRUSTED_HOSTS`
entry (`docker compose logs dsh | grep 'dsh web'`).

## Exposure beyond your own network

The WebUI is protected by a per-launch token (a single shared per-process
credential, printed to the container logs) — not per-user authentication.
Anyone with the token who can reach port 3080 gets a fully agent-capable
session. Do **not** expose it directly to the internet or an untrusted
network.

If you need access from outside your own network, put a reverse proxy with
authentication in front of it (HTTPS-terminating, e.g. Traefik, Caddy, or nginx
with forward auth / basic auth, or an SSO layer such as Authelia or
oauth2-proxy), and:

- bind the port to localhost only (`"127.0.0.1:3080:3080"` in `compose.yaml`)
  and proxy to it, or restrict the port to the proxy's docker network instead of
  publishing it at all
- add the public hostname to `TRUSTED_HOSTS` (e.g. `dsh.example.com:443`)

### Auth behind an authenticating reverse proxy

dsh protects the WebUI with a per-launch token: `dsh web` prints one `?token=`
URL per process, that URL mints an HMAC cookie bound to the exact request
authority (`Host` including port), and both the index document and every `/api`
request need it. The token is not per user and cannot be revoked per client;
a cleared browser cookie or a second access authority
(`https://dsh.example.com` vs. `http://192.168.1.10:3080`) means the 401
`dsh web authentication required; reopen the URL printed by dsh web` until the
printed URL is opened again.

When a reverse proxy already authenticates the user, that second gate can be
replaced by the proxy:

```sh
# .env
DSH_TRUST_REVERSE_PROXY_AUTH=1
```

With the flag on, the WebUI opens at the plain root URL — no token URL, no
cookie. What stays in force is the Host/Origin trust fence: a request still
needs a loopback `Host` or a `TRUSTED_HOSTS` entry (mandatory for every
non-loopback authority), and an attached `Origin` must equal that `Host`, so
DNS-rebinding and cross-site requests stay refused with 403. Cookie minting
keeps working, so the printed token URLs remain usable as a fallback.

The flag removes authentication, not reachability: anyone who can reach port
3080 can send a trusted `Host` header themselves. Reachability is therefore
part of the security model — either restrict the published port to the proxy
(bind `127.0.0.1:3080:3080`, attach the proxy to the container network, or
firewall the port down to the proxy/VPN interface), or set
`DSH_PROXY_AUTH_SECRET` and let the proxy inject `x-dsh-proxy-auth: <secret>`
on every upstream request: without that header every request stays 401, so the
port alone is no longer enough. Both variables are read when the process
starts, so a change needs `docker compose up -d --force-recreate`.

The patch is `patches/trusted-proxy-auth.mjs` (build-time, fail-closed, applied
in the `Dockerfile`); with the flag unset the image behaves exactly like stock
dsh.

Smoke test after `docker compose up -d --build` (internal port 3081, a
`TRUSTED_HOSTS` authority as `Host`) — 200 with the flag, 401 without it, and
with `DSH_PROXY_AUTH_SECRET` set add `-H "x-dsh-proxy-auth: <secret>"`:

```sh
docker compose exec dsh sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" -H "Host: dsh.example.com" http://127.0.0.1:3081/'
```

### Remote configuration

Before 0.1.2, dsh pinned the settings/credentials/agent-preset management
surface to loopback, so browsers on a LAN IP or proxy hostname saw "settings
are unavailable in this browser". The 0.1.2 rewrite replaced that
server-side fence with the uniform Host/Origin trust fence plus browser
launch-token auth; the remaining client-side loopback pin is a UI courtesy
that this image patches at build time
(`patches/enable-remote-configuration.mjs`, adapted from
StefanKhor/deepseek-harness-docker, MIT). Settings therefore works from every
authority in `TRUSTED_HOSTS` — the old `DSH_ALLOW_REMOTE_CONFIGURATION` flag
is removed (it only gated the deleted server half and would be a no-op).

Effective access control is `TRUSTED_HOSTS` + the per-launch token (which can be
replaced by an authenticating proxy — see "Auth behind an authenticating
reverse proxy") + any reverse proxy in front: anyone who can reach the WebUI
(and holds the token) can read and change settings and credentials. Keep the
authenticating reverse proxy from the previous section in place when exposing
the UI beyond your own network.

### WebUI downlink watchdog

0.1.2 heartbeats the host side of the Remote-stream WebSocket
(`@deepseek-ai/dsh-api-gateway` pings every socket and terminates it after two
missed pongs; interval configurable via the api-gateway plugin's
`websocketHeartbeatIntervalMs`, default 2000 ms). The browser, however, cannot
observe WebSocket ping/pong and its `RemoteStreamMuxClient` reconnects only on
the socket `close`/`error` event. A downlink that dies silently — reverse-proxy
idle drop, NAT timeout, WireGuard re-key, a stalled tunnel — therefore left the
WebUI frozen while it still displayed "connected", and only a page reload
recovered it.

`patches/stream-stall-watchdog.mjs` closes that gap and is applied at build
time (both halves are required, the build fails on any `WARN:` in the log):

- host half: next to each heartbeat ping, the server sends the tiny application
  frame `{"type":"keepalive"}`;
- browser half: that frame is dropped and re-arms a socket-bound stall watchdog.
  When no frame arrives for `globalThis.__DSH_STREAM_STALL_MS` (default
  30000 ms), the existing `RemoteStreamMuxClient.reconnect()` path runs — the
  logical streams fail, the domain layer reopens them and resyncs, exactly like
  a socket close. No page reload is needed.

Keep the stall threshold comfortably above `websocketHeartbeatIntervalMs`
(15x at the defaults). If you raise the heartbeat interval in the plugin
config, raise `__DSH_STREAM_STALL_MS` in the same ratio. The needle-based patch
is verified against dsh 0.1.2-rc.1; a DSH version bump that changes these
bundles fails the image build on purpose, so the patch is re-checked before it
silently stops matching.

After an update, reload an already open tab once: a cached old bundle treats
the keepalive frame as an invalid carrier frame and reconnects once.

### Reconnecting indicator during normal operation

The WebUI shows a warning indicator next to the settings entry ("reconnecting...",
then "recovered") whenever the client connection generation is aborted and rebuilt.
On a phone that happened during ordinary use, without anything actually being
lost, because the client reacts to the browser's own network events:

`@deepseek-ai/dsh-client-connection` mirrors `navigator.onLine` through the
`online`/`offline` window events and aborts the running generation on every
transition. `navigator.onLine` is not a reliable liveness signal on mobile: it
reports `offline` for routine transitions (Wi-Fi/cellular handover, radio state
changes while the screen is off, brief tunnel hiccups) while the already-open
socket keeps working.

Reproduced on 2026-09-10 by driving a browser through CDP: switching the page
offline and online again produced exactly one forced reconnect — console
`[connection] connection lost, retry #1`, a new `/api/remote.mux` socket, and the
indicator — although no packet had been lost. The server side is healthy in the
same window: heartbeats arrive every 2000 ms with no gap above ~2 s over minutes,
and a main thread blocked for 6 s does not kill the socket (Chrome answers
WebSocket pings outside the renderer).

`patches/network-availability-churn.mjs` narrows that abort in
`dsh-client-connection/lib/client.js`: the controller tracks whether the running
attempt has already delivered a connection, and `setNetworkAvailable` aborts only
an attempt that has not. An established connection survives the event; if the
network really died, the socket fails on its own (the Host terminates it after two
missed heartbeats, about 4 s) and the normal close/retry path runs with retries
suspended while offline. Verified in a browser against the unpatched bundle with
the same driver: original 3 aborts over two flaps, patched 0 — and an attempt that
never became ready is still aborted in both.

Client bundles are composed per request and served cache-busted, so this half of
the fix is live on the next page load rather than at container start; the build
still applies it for reproducibility. The needle-based `WARN:` gate fails the
image build if a DSH bump moves the seams.

### WebUI transfer size

The WebUI shell renders in 2-3 s even on a phone, but its data (workspaces,
sessions) follows seconds later. Measured on 2026-09-10 with a mobile-emulated
browser at 412x915, slow 4G (1.6 Mbit/s, 200 ms RTT) and CPU throttled 4x:

- DOMContentLoaded 2.4-3.5 s, but `load` 3.4-10.6 s on a warm reload, with 4-5
  long tasks of up to 1341 ms blocking the main thread.
- The single largest resource is `/plugins/??...` — the composed client plugin
  bundle: **5.7 MB of JavaScript** in 46 modules, downloaded whole on every page
  load and parsed before any session or workspace data can be requested.
- The shell's own assets (vendor 740 KB, app 423 KB, CSS 67 KB decoded) carried
  no cache headers at all, so ~390 KB gzip came down again on every reload.

Two host-half patches close that, both applied at build time:

- `patches/brotli-compression.mjs` inserts a brotli seat ahead of the shipped
  gzip middleware (configured at level 1). A client offering `br` gets the same
  bodies at brotli quality 6 — the plugin bundle drops from 1,639,165 to
  1,152,095 bytes (-29.7%), `/api` JSON and hashed assets shrink too (session
  list 423 KB decoded: 78 KB gzip -> 71 KB br). Server CPU per request for the
  plugin bundle: 108 ms vs 46 ms for gzip-1, paid once per page load on a
  resource the browser then caches immutably.
- `patches/static-cache-headers.mjs` gives the dist its cache policy:
  `/assets/...` and `/plugins/...` are `public, max-age=31536000, immutable`,
  the rendered `index.html` stays `no-cache`, and every other dist file is
  stored for a day and revalidated by `etag`/`last-modified` with a `304` — so a
  warm reload re-fetches no shell asset at all.

Deliberate difference to be aware of: for a client that offers *both* gzip and
brotli, the seat finalizes the response, so bodies it declines (below the
1024-byte threshold, non-200, or streamed through `res.write`) are sent
uncompressed instead of gzip-1. Clients that do not offer brotli — gzip-only
agents, older browsers — keep the completely untouched gzip path.

Both patches are needle-based and fail-closed like the others: a DSH version
bump that moves the seams makes the image build fail on the `WARN:` gate instead
of silently serving gzip-1 again. After a rebuild, verify a running server shows
`content-encoding: br` for `/plugins/??...` and `cache-control` on `/assets/...`,
and confirm the same responses against a gzip-only client.

### Previewing a page in the container

The agent runs inside the container, so a page it produces (a built site, a report,
a game, a running dev server) is normally unreachable from your browser: only the
DSH port is published. The image ships the `show_website` host plugin for that,
which mounts a local file, a directory, or a running server on the DSH origin
under `/preview/<id>/`.

**It is shipped ready to load, not registered.** Nothing is active until you add
the two lines below to `$DSH_HOME/profiles/web/cordis.patch.yml`
(`/data/profiles/web/cordis.patch.yml` on the volume):

```yaml
- insert:
    - id: show-website
      name: /usr/local/share/dsh-plugins/show-website/index.mjs
```

The path must stay absolute: a `./plugins/...` name is resolved relative to the
patch file (inside the volume), not to the image. After the edit, reload is live
(`patchReload: live`) — no container restart needed. A broken row added by a live
edit is logged and rolled back; keep an eye on the container log the first time.

Why not on by default: every layer of a profile composes into **one** transactional
loader update, so a single bad row — an import error, a missing `apply`, or an
unmet `inject` — makes `dsh web` exit 1. As PID 1 under `restart: unless-stopped`
with a persistent volume that is a crash loop with nothing served, and a plugin
tracking harness-internal APIs is exactly the row that can go bad on a routine dsh
update. To switch it off again, either delete the row or keep it and add
`- id: show-website` / `disabled: true` (machine-wide: `$DSH_HOME/cordis.patch.yml`,
which outranks the profile layer). A patch can only override a row's `config` and
`disabled` — it cannot swap the module behind it.

Agent usage:

```text
show_website({ id: "game", dir: "/abs/path/to/dist" })          # static files
show_website({ id: "game", target: "http://127.0.0.1:5273" })   # running server, WebSocket proxied
show_website({ action: "list" })                                # published previews
show_website({ action: "close", id: "game" })
```

A dev server that emits root-absolute URLs needs its base to match the mount
(`vite --base=/preview/game/ --port 5273 --strictPort`); a server that serves at
its own root takes `strip_prefix: true`.

**Access control.** `patches/preview-auth-gate.mjs` puts preview routes behind the
same verdict as `/api` (`connection.requestRejection`, i.e. the Host/Origin trust
fence plus the launch-token cookie), for HTTP and for WebSocket upgrades, and
answers 503 rather than serving when that service is unavailable. Before that patch
a published preview was readable by anyone who could reach the port, with no cookie
and not even a `Host` check. Two limits remain:

- With `DSH_TRUST_REVERSE_PROXY_AUTH=1` and no `DSH_PROXY_AUTH_SECRET`, previews are
  reachable exactly like `/api` and the index: the reverse proxy is the only
  authentication. That is already true of the whole WebUI in that mode.
- In proxy mode the target is **any** HTTP host the container can reach — not just
  loopback — and requests are forwarded verbatim, methods and bodies included.
  The target is documented in the `list` output; treat the tool as "publish to
  whoever can reach my DSH port".

An older copy of this plugin may still sit in the volume
(`/data/profiles/web/plugins/show-website/`). A volume row that names that relative
path keeps loading the volume copy; registration is not deduplicated by name, so
point the row at the image path (or delete the volume copy) to get the version
that ships with the image.

### Server memory and GC stalls

`dsh web` is one Node process that owns every agent loop, the `/api` RPC surface
and the Remote-stream WebSocket. A long-running or large agent session pushes
the process against Node's default V8 heap ceiling (4288 MB on this image).
V8 then stops doing incremental marking and runs an emergency full GC on the
main thread: measured on 2026-09-10 with a 2.6 GB live set and roughly 1.8 GB/min
of garbage, RSS climbed to 4.3-4.5 GB within ~60 s and the event loop froze for
10-12 s (11.4 s of main-thread CPU for an 11.2 s freeze), then RSS dropped back
to 2.6 GB.

During such a freeze every fresh request hangs: the session list, the subagent
catalog (`POST /api/subagents/list`), opening a child session, sending a message.
Already-loaded sessions keep switching because that is client-local state — the
UI therefore looks "partially" frozen rather than dead.

`compose.yaml` raises the ceiling:

```yaml
NODE_OPTIONS: "${NODE_OPTIONS:---max-old-space-size=8192}"
```

Verify by timing any request against the running server — even the trivial
unauthenticated `401` shares the event loop, so a stall shows up here. Run it in
the container (`docker compose exec dsh bash`):

```
for i in $(seq 1 300); do
  curl -s -o /dev/null -w "%{time_total}\n" -m 40 -H "Host: 127.0.0.1:3081" \
    http://127.0.0.1:3081/
  sleep 0.3
done | sort -n | tail -3
```

A healthy server stays in the low milliseconds (the tail may show a few hundred
ms). Anything in the seconds is a freeze. Watch `VmRSS` in
`/proc/$(pgrep -f 'dsh web' | head -1)/status` as well: it should plateau below
the new ceiling instead of parking on it.

If stalls persist with the larger heap, the live set itself is the lever — the
host keeps the complete event log of every live session in memory, so a session
with hundreds of thousands of events (this deployment had one at 457k) dominates
RSS. Closing such a session in the UI (or archiving it) releases it.

### Upgrading to 0.1.2 with profile plugins

0.1.2 tightened how the client module system identifies a plugin package, and
it removed `@deepseek-ai/dsh-client-runtime`. Two consequences for plugins
installed in the profile volume (e.g. `dsh-workspace`):

- The profile dependency alias, the plugin's `package.json` `name`, and the
  module id its client bundle registers in `__ModuleLoader__.load({ id })` must
  agree. `dsh-workspace` up to 1.1.0 declares `name: "@mainzerp/dsh-workspace"`
  while the profile installs it as `dsh-workspace`: 0.1.2 then silently skips
  the client half (the host half stays `active` in the plugin inventory) and the
  project panel disappears. Setting `"name": "dsh-workspace"` in the plugin's
  `package.json` fixes it (verified against 0.1.2-rc.1).
- A plugin that still injects `@deepseek-ai/dsh-client-runtime` (0.4.2 and
  older) cannot load at all on 0.1.2. Refresh the profile after the upgrade:

  ```
  docker compose exec dsh sh -c 'CI=true dsh plugin --profile web install'
  ```

  `CI=true` avoids pnpm's "Aborted removal of modules directory due to no TTY".
  `dsh-workspace` main is at 1.1.0 and targets 0.1.2.

## Persistence

| Path | Contents |
| ---- | -------- |
| Volume `dsh-data` -> `/data` | `$DSH_HOME`: profiles, installed plugins, `settings.yaml`, `.credentials.yaml`, `.env` |
| Volume `dsh-home` -> `/home/node` | Agent home: workspaces (the WebUI creates them here), `gh` auth, `.gitconfig`, tool caches |

Everything outside these two volumes lives in the container layer and is lost
on recreation (`--force-recreate`, image updates). Keep all mutable state under
`/data` or `/home/node`.

Install plugins with `docker compose exec dsh dsh plugin --profile web add <pkg>`;
they live in `/data/profiles/web/` and survive container restarts and image rebuilds.

The image also carries plugin **code** that is not registered anywhere:
`/usr/local/share/dsh-plugins/` (see
[Previewing a page in the container](#previewing-a-page-in-the-container)). It is
part of the container layer, so an image update replaces it, and an existing
volume's profile is never rewritten to point at it — activation is a profile-patch
edit by the operator.

Runtime package installation:

| Kind | Installable at runtime? | Survives restart? | Survives rebuild? |
| ---- | ----------------------- | ----------------- | ----------------- |
| dsh plugins | Yes | Yes (volume) | Yes |
| Shipped, unregistered plugin code in `/usr/local/share/dsh-plugins/` | No — part of the image | — | Yes (replaced by the new image) |
| npm/pnpm packages in workspace | Yes | Yes (volume) | Yes |
| System packages (`apt`) | No — container runs as unprivileged `node` user | — | — |

System packages belong in the `Dockerfile`; that is the only durable way.

## Configuration

- `DEEPSEEK_API_KEY` — required for model access and web search; read from `.env` or
  `/data/.env` / `/data/.credentials.yaml`
- `TRUSTED_HOSTS` — see above
- `DSH_TRUST_REVERSE_PROXY_AUTH` — `1/true/yes/on` skips dsh's own
  browser-session gate so an authenticating reverse proxy is the only gate; see
  "Auth behind an authenticating reverse proxy"
- `DSH_PROXY_AUTH_SECRET` — optional hardening for the flag above: requests pass
  only with the proxy-injected header `x-dsh-proxy-auth: <secret>`
- `DSH_PORT` — external port inside the container (default 3080)
- `DSH_VERSION` — pin the npm version: set `DSH_VERSION=0.1.2-rc.1` in `.env`
  (passed through as a build arg), then `docker compose up -d --build`
- `DSH_TELEMETRY_DISABLED` — image default `1` (telemetry off); set to an empty
  value to enable upstream telemetry
- `NODE_OPTIONS` — Node/V8 flags for `dsh web`; compose sets
  `--max-old-space-size=8192` by default (see "Server memory and GC stalls").
  Raising it trades RAM for fewer GC freezes; keep the value below the memory
  you are willing to give the container.
- `GH_VERSION` — GitHub CLI version in the image (default in `Dockerfile`)
- `PLAYWRIGHT_VERSION` — Playwright version for browser tooling (default in `Dockerfile`)
- `UV_VERSION` — uv version in the image (default in `Dockerfile`)
- `DEEPSEEK_BASE_URL` / `DSH_MODEL` / `DSH_SYSTEM_PROMPT` — optional dsh config
  overrides (commented out in `.env.example`; authoritative reference:
  `docs/config-catalog.md` in the dsh repo)
- Model catalog and model selection live in `/data/settings.yaml`
  (`llm-deepseek.models`, `agent-default-model`), not in the image. The file is
  hot-reloaded, so edits apply without a restart.
- Image input is declared per model in that catalog: a model entry without
  `inputModalities: [text, image]` makes `read_image` refuse the request, even
  when the model itself is multimodal. `imagePixelBudget` and `imageMaxBytes`
  are only valid together with `image` in `inputModalities`.

## Git / GitHub in the container

The image includes `git`, `curl`, and the GitHub CLI (`gh`) — see the next
section for the full toolchain. The agent in the
container runs as the unprivileged `node` user and cannot install system packages
at runtime — required tools belong in the image.

Authenticating with GitHub:

```sh
docker compose exec dsh gh auth login        # interactive (device flow)
# or bootstrap from the GH_TOKEN env var (token never printed):
docker compose exec dsh sh -c 'printenv GH_TOKEN | gh auth login --with-token'
```

The token needs the scopes `repo` and `read:org` (plus `workflow` to push
workflow files). `gh` stores its credentials in `~/.config/gh/hosts.yml`,
which lives on the `dsh-home` volume — one login survives container
recreations. Afterwards `gh auth setup-git` (once) makes plain `git` push/pull
use the stored token.

Note: dsh deliberately scrubs every env var matching `KEY|PASSWORD|SECRET|TOKEN`
from agent subprocesses, so `GH_TOKEN` set on the container is **not** visible
inside agent shells — the stored `gh` login above is the supported path, the
env var is only the bootstrap source for `docker compose exec` shells.

For commits, git needs an identity. Either set it once (persists on the
`dsh-home` volume):

```sh
docker compose exec dsh git config --global user.name "Your Name"
docker compose exec dsh git config --global user.email "you@example.com"
```

or pass it per-run via env (git reads these variables automatically):

```
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
GIT_COMMITTER_NAME=Your Name
GIT_COMMITTER_EMAIL=you@example.com
```

## Dev environment in the container

The base image is `node:24-bookworm` (full buildpack-deps toolchain: gcc/g++/make,
git, curl, and the common build libraries are already included).

Preinstalled CLIs: `gh`, `jq`, `rg`, `ffmpeg`, `socat`, `bwrap` (bubblewrap),
`tree`, `tmux`, `htop`, `rsync`, `sqlite3`, plus `python3` (3.11),
`python3-venv`, `pip`, and `uv`.

- Python: system Python is PEP 668 "externally managed" — always use
  `python3 -m venv .venv` or `uv venv` for package installs. Other Python
  versions are available at runtime without root, e.g. `uv venv --python 3.13`.
- Playwright: global `playwright` CLI/library plus Chromium at `/ms-playwright`
  (`PLAYWRIGHT_BROWSERS_PATH` is set image-wide). Headless works out of the box;
  `xvfb-run` is available for headed runs.
- Pinning caveat: the bundled browsers match the image's global Playwright
  version. A workspace project using a different Playwright version must run its
  own `npx playwright install chromium` (installs into `/ms-playwright` as the
  `node` user).
- The container runs with `init: true` and `shm_size: 1gb` for Chromium
  stability (zombie reaping, shared-memory headroom).
- Fonts: Playwright pulls Liberation, FreeFont, Unifont, Noto Color Emoji,
  ipafont-gothic (JP), wqy-zenhei (CN) and tlwg-loma (TH). For Korean or full
  CJK coverage add `fonts-noto-cjk` to the apt line in the `Dockerfile`.

### GPU passthrough (Intel iGPU)

Both compose files pass the host's `/dev/dri` into the container and grant the
`video` and render groups, so headless Chromium renders on the Intel iGPU instead
of SwiftShader (CPU). The image provides the matching userspace: Mesa EGL/GLES
(`libegl1`, `libegl-mesa0`, `libgles2`), the Intel ANV Vulkan ICD
(`mesa-vulkan-drivers`) and `vulkaninfo`; the Mesa DRI drivers (`iris`, `i915`)
arrive with Playwright's own dependencies. Plain `chromium.launch()` calls are
accelerated as well, because the image patches Playwright's default Chromium
arguments at build time (first bullet below); Playwright never passes
`--disable-gpu`, and the `--enable-unsafe-swiftshader` it does add stays as the
fallback path.

- **Default-argument patch** (`patches/chromium-gpu-default.mjs`, applied by the
  `Dockerfile`): Chromium picks no hardware backend by itself in this container —
  measured with `/dev/dri` passed through, device nodes readable and the Intel
  ICDs installed, a plain launch still reported SwiftShader while the same launch
  with `--use-angle=gl-egl` reported the Intel iGPU. No environment variable
  reaches that decision (`ANGLE_DEFAULT_PLATFORM` and `VK_ICD_FILENAMES` were both
  measured ineffective) and Playwright has no environment hook for Chromium
  arguments, so the patch appends `--use-angle=gl-egl`, gated on a runtime check
  that the launching user can open `/dev/dri/renderD128`. A host without GPU
  access keeps the stock SwiftShader fallback, and a project that passes its own
  `--use-gl`/`--use-angle` wins unchanged. Only the global Playwright install is
  patched: a workspace project that installs its own Playwright version must pass
  `args: ['--use-angle=gl-egl']` itself. The patch is idempotent, and the image
  build fails when its needle drifts (fail-closed).
- Host prerequisite: `/dev/dri` (Intel or AMD iGPU with the `i915`/`amdgpu`
  kernel module). On a host without it, `docker compose up` fails with
  `error gathering device information`; remove the `devices:`/`group_add:`
  entries in that case.
- Both nodes are `0660`, so both need a group. `card0` is `root:video`, and
  `video` is GID 44 on Debian and Ubuntu alike. The render node
  (`/dev/dri/renderD128`) is `root:render`, and the render GID is **not** fixed
  across distributions — measured 109 on the reference host (Ubuntu 22.04), where
  upstream systemd's `0666` default did not apply. Without that group the Intel
  driver fails with `Unable to open device /dev/dri/renderD128: Permission denied`
  and Chromium stays on SwiftShader. Look the GID up on the host and override it
  if it differs from the default:

  ```sh
  stat -c '%g' /dev/dri/renderD128   # -> RENDER_GID in .env (default 109)
  ```
- Verify inside the container, from this repo checkout:

  ```sh
  node scripts/gpu-check.mjs
  ```

  It checks the devices, the userspace and the patch marker, then launches
  Chromium with several flag sets and prints the WebGL renderer for each. Exit
  code 0 requires the **default** configuration (no extra flags) to render on the
  GPU; exit code 1 means software rendering, a missing patch marker, or hardware
  only reachable with explicit args. Expected renderer:
  `ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (ADL-S GT1), OpenGL ES 3.2)`.
- If the default configuration still reports SwiftShader, use the flag set the
  script marks as working, e.g. `chromium.launch({ args: ['--use-angle=gl-egl'] })`,
  or run the check headful under the image's `xvfb`
  (`GPU_CHECK_HEADFUL=1 xvfb-run -a node scripts/gpu-check.mjs`).
- **Runs that bypass Playwright** (Puppeteer, or a Chrome started directly) are
  never patched — pass the flag yourself and drop the software switches:

  ```sh
  /path/to/chrome --headless=new --no-sandbox --use-angle=gl-egl \
    --remote-debugging-port=9222 URL
  ```

  Measured in this container with the Puppeteer-downloaded Chrome 152: with
  `--disable-gpu --enable-unsafe-swiftshader` its GPU process reports
  `--use-angle=swiftshader-webgl` and holds no open DRM file descriptor
  (software); no flags at all is software as well, because Chromium selects no
  hardware backend by itself here; `--use-angle=gl-egl` reports
  `ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (ADL-S GT1), OpenGL ES 3.2)`.
  Never combine an intent to use the GPU with `--disable-gpu`,
  `--use-gl=swiftshader` or `--enable-unsafe-swiftshader`.
- Without a GPU the same image keeps working: Chromium then falls back to
  SwiftShader as before. Hardware video decode (VA-API) is not installed.
- Device passthrough and group membership only take effect when the container is
  recreated (`docker compose up -d --force-recreate`), which restarts `dsh web`.

### Model providers

Beyond DeepSeek, the Web UI (Settings -> Models) supports catalog providers
(Anthropic, OpenAI, Bedrock, Vertex, Azure, Codex — the latter need native
credentials) and custom OpenAI-compatible endpoints. Keys are stored in
`$DSH_HOME/.credentials.yaml` and therefore persist via the `/data` volume.
Env vars (e.g. `ANTHROPIC_API_KEY`) are only needed for provider entries that
reference them via `apiKeyEnv` (see `.env.example`).

### Sandboxing

dsh confines agent subprocesses with bubblewrap (preferred; apt-installed in
the image) and falls back to the `landlock-run` launcher, whose prebuilt
binaries ship with the npm package (platform-restricted optional deps of
`@deepseek-ai/dsh-sandbox-local` — installed by the default
`npm install -g`, no image support needed). Enforcement is fail-closed and
depends on the host: landlock needs kernel 5.13+ with Landlock enabled and a
Docker seccomp profile that permits the `landlock_*` syscalls (current Docker
does); bubblewrap needs user-namespace support, which some Docker setups
restrict. On WSL2/Docker Desktop the WSL2 kernel determines availability —
check the runtime status
(`docker compose logs dsh | grep -i -E 'landlock|sandbox|bwrap'`, or ask the
agent to run a sandboxed bash call) rather than assuming. If neither runner
works, dsh reports `SANDBOX_UNAVAILABLE` instead of silently running
unconfined. `DSH_PERMISSION_MODE=danger-full-access` exists as an escape hatch
but is deliberately NOT the image default.

## Note

DeepSeek Harness is in developer preview; breaking changes between versions are
expected. If an update causes problems, pin the version (see `DSH_VERSION`).
The dsh repo docs tree (`docs/tool-catalog.md`, `docs/config-catalog.md`,
`docs/user/`) is the authoritative reference for dsh behavior.
