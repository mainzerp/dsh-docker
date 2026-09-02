# dsh-docker

Docker deployment for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) with access through the WebUI.

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
automatically when a new upstream release-candidate or stable git tag (`dsh-v*` — alpha/beta
prereleases are excluded on purpose; build those locally via `DSH_VERSION`) appears on
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh is no longer published to npm), publishing
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

### Remote configuration

Before 0.1.2, dsh pinned the settings/credentials/agent-preset management
surface to loopback, so browsers on a LAN IP or proxy hostname saw "settings
are unavailable in this browser". The harness rewrite replaced that
server-side fence with the uniform Host/Origin trust fence plus browser
launch-token auth; the remaining client-side loopback pin is a UI courtesy
that this image patches at build time
(`patches/enable-remote-configuration.mjs`, adapted from
StefanKhor/deepseek-harness-docker, MIT). Settings therefore works from every
authority in `TRUSTED_HOSTS` — the old `DSH_ALLOW_REMOTE_CONFIGURATION` flag
is removed (it only gated the deleted server half and would be a no-op).

Effective access control is `TRUSTED_HOSTS` + the per-launch token + any
reverse proxy in front: anyone who can reach the WebUI (and holds the token)
can read and change settings and credentials. Keep the authenticating
reverse proxy from the previous section in place when exposing the UI beyond
your own network.

## Persistence

| Path | Contents |
| ---- | -------- |
| Volume `dsh-data` -> `/data` | `$DSH_HOME`: profiles, installed plugins, `.credentials.yaml`, `.env` |
| Volume `dsh-home` -> `/home/node` | Agent home: workspaces (the WebUI creates them here), `gh` auth, `.gitconfig`, tool caches |

Everything outside these two volumes lives in the container layer and is lost
on recreation (`--force-recreate`, image updates). Keep all mutable state under
`/data` or `/home/node`.

Install plugins with `docker compose exec dsh dsh plugin --profile web add <pkg>`;
they live in `/data/profiles/web/` and survive container restarts and image rebuilds.

Runtime package installation:

| Kind | Installable at runtime? | Survives restart? | Survives rebuild? |
| ---- | ----------------------- | ----------------- | ----------------- |
| dsh plugins | Yes | Yes (volume) | Yes |
| npm/pnpm packages in workspace | Yes | Yes (volume) | Yes |
| System packages (`apt`) | No — container runs as unprivileged `node` user | — | — |

System packages belong in the `Dockerfile`; that is the only durable way.

## Configuration

- `DEEPSEEK_API_KEY` — required for model access and web search; read from `.env` or
  `/data/.env` / `/data/.credentials.yaml`
- `TRUSTED_HOSTS` — see above
- `DSH_PORT` — external port inside the container (default 3080)
- `DSH_VERSION` — upstream git tag to build dsh from, e.g. `dsh-v0.1.2-alpha.4`
  in `.env` (passed through as a build arg), then `docker compose up -d --build`.
  dsh is built from source: expect ~15-30 min and >=6 GB RAM for the builder
  stage
- `DSH_TELEMETRY_DISABLED` — image default `1` (telemetry off); set to an empty
  value to enable upstream telemetry
- `GH_VERSION` — GitHub CLI version in the image (default in `Dockerfile`)
- `PLAYWRIGHT_VERSION` — Playwright version for browser tooling (default in `Dockerfile`)
- `UV_VERSION` — uv version in the image (default in `Dockerfile`)
- `DEEPSEEK_BASE_URL` / `DSH_MODEL` / `DSH_SYSTEM_PROMPT` — optional dsh config
  overrides (commented out in `.env.example`; authoritative reference:
  `docs/config-catalog.md` in the dsh repo)

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

### Model providers

Beyond DeepSeek, the Web UI (Settings -> Models) supports catalog providers
(Anthropic, OpenAI, Bedrock, Vertex, Azure, Codex — the latter need native
credentials) and custom OpenAI-compatible endpoints. Keys are stored in
`$DSH_HOME/.credentials.yaml` and therefore persist via the `/data` volume.
Env vars (e.g. `ANTHROPIC_API_KEY`) are only needed for provider entries that
reference them via `apiKeyEnv` (see `.env.example`).

### Sandboxing

dsh confines agent subprocesses with bubblewrap (preferred; apt-installed in
the image) and falls back to `landlock-run` (built from source in the image as
a static musl binary). Enforcement is fail-closed and depends on the host:
landlock needs kernel 5.13+ with Landlock enabled and a Docker seccomp profile
that permits the `landlock_*` syscalls (current Docker does); bubblewrap needs
user-namespace support, which some Docker setups restrict. On WSL2/Docker
Desktop the WSL2 kernel determines availability — check the runtime status
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
