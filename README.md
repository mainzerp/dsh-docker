# dsh-docker

Docker deployment for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) with access through the WebUI.

## Quickstart

```sh
cp .env.example .env   # set DEEPSEEK_API_KEY and, if needed, TRUSTED_HOSTS
docker compose up -d --build
```

WebUI: `http://localhost:3080` or `http://<lan-host>:3080`.

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

Then run `docker compose up -d` again.

## Persistence

| Path | Contents |
| ---- | -------- |
| Volume `dsh-data` -> `/data` | `$DSH_HOME`: profiles, installed plugins, `.credentials.yaml`, `.env` |
| Volume `dsh-workspace` -> `/workspace` | Workspace root of the agent; create workspaces here (`/workspace/<name>`) |

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
- `DSH_VERSION` — pin the npm version: set `DSH_VERSION=0.1.0-rc.7` in `.env`
  (passed through as a build arg), then `docker compose up -d --build`
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
# or a token via .env: GH_TOKEN=ghp_... or GITHUB_TOKEN=...
```

For commits, set the identity via `.env` (git reads these variables automatically;
they survive container recreation):

```
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
GIT_COMMITTER_NAME=Your Name
GIT_COMMITTER_EMAIL=you@example.com
```

Note: `gh auth login` writes to `~/.config/gh` in the container layer and is lost
when the container is recreated. A token via `.env` (`GH_TOKEN`) is the durable option.

## Dev environment in the container

The base image is `node:24-bookworm` (full buildpack-deps toolchain: gcc/g++/make,
git, curl, and the common build libraries are already included).

Preinstalled CLIs: `gh`, `jq`, `rg`, `ffmpeg`, `socat`, `tree`, `tmux`, `htop`,
`rsync`, `sqlite3`, plus `python3` (3.11), `python3-venv`, `pip`, and `uv`.

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

dsh confines agent subprocesses with Landlock (`landlock-run`, prebuilt binaries
ship with dsh via npm — no image support needed). Enforcement is fail-closed and
depends on the host: kernel 5.13+ with Landlock enabled and a Docker version
whose default seccomp profile permits the `landlock_*` syscalls (current Docker
does; not pinned to a specific minimum version). On WSL2/Docker Desktop the WSL2
kernel determines availability — check the runtime status
(`docker compose logs dsh | grep -i -E 'landlock|sandbox'`) rather than
assuming. If unsupported, dsh reports the sandbox as `unusable` instead of
silently running unconfined.

## Note

DeepSeek Harness is in developer preview; breaking changes between versions are
expected. If an update causes problems, pin the version (see `DSH_VERSION`).
The dsh repo docs tree (`docs/tool-catalog.md`, `docs/config-catalog.md`,
`docs/user/`) is the authoritative reference for dsh behavior.
