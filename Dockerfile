FROM node:24-bookworm

# --- System tools ---
# Base image (buildpack-deps:bookworm) already provides: gcc, g++, make, dpkg-dev,
# git, curl, ca-certificates, wget, gnupg, openssh-client, procps, imagemagick, file,
# patch, unzip, xz-utils, and the common -dev libraries. Do NOT reinstall those.
# socat: TCP forwarder, because `dsh web` intentionally does not support --host 0.0.0.0
# bubblewrap: sandbox runner for agent subprocesses (preferred; the landlock
#   launcher ships with the npm package as the fallback)
# python3/-venv/-pip: baseline Python 3.11 (bookworm); system pip is PEP 668
#   "externally managed" — use venvs (or uv) for package installs
# jq, ripgrep, ffmpeg: universal CLI tools for the agent
# tree, less, vim-tiny, tmux, htop, rsync, sqlite3, zip: small standard utilities
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       socat \
       bubblewrap \
       python3 python3-venv python3-pip \
       jq ripgrep ffmpeg \
       tree less vim-tiny tmux htop rsync sqlite3 zip \
    && rm -rf /var/lib/apt/lists/*

# uv: fast package manager + runtime Python installer (any version, no root needed).
# Release tarball from GitHub (the distroless COPY --from=ghcr.io/... pattern needs
# working ghcr.io access; the tarball is registry-independent like the gh CLI below).
ARG UV_VERSION=0.12.5
RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
    | tar xz -C /tmp \
    && mv /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/ \
    && rm -rf /tmp/uv-x86_64-unknown-linux-gnu

# GitHub CLI (release tarball, avoiding the apt repository)
ARG GH_VERSION=2.97.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_amd64"

# pnpm is required by `dsh plugin` for plugin management
RUN corepack enable && corepack prepare pnpm@latest --activate

# DSH_VERSION is an npm version/dist-tag of @deepseek-ai/dsh (NOT a git tag).
# Default install (no --omit=optional): the landlock launcher ships as a
# platform-restricted optional dep of @deepseek-ai/node-addon-system (a plain
# dependency of @deepseek-ai/dsh-sandbox-local), so the sandbox fallback binary
# comes in with the regular install. 0.1.2 delivered it through the retired
# @deepseek-ai/node-addon-landlock-run package; `--omit=optional` would drop
# @deepseek-ai/node-addon-system-linux-x64 and with it the fallback.
# npm 11 blocks dependency install scripts by default; that is harmless on
# linux/x64 (node-pty ships its prebuild in the tarball, koffi uses its
# @koromix/koffi-linux-x64 optional prebuild, ensure-spawn-helper is a no-op).
ARG DSH_VERSION=0.1.5-rc.2
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

# Build-time gate: the installed CLI must run and report its version
# (logged for the build log; intentionally not string-matched).
RUN version=$(node "$(npm root -g)/@deepseek-ai/dsh/lib/bin.js" --version) \
    && echo "installed dsh version: ${version}"

# Remote-configuration patch (browser half only, applied unconditionally at
# build time). Since 0.1.2 upstream's server-side loopback fence is gone —
# replaced by the Host/Origin trust fence plus launch-token auth — so only the
# client-side isLoopback pin remains, and the patch lifts it. See README
# "Remote configuration" for the security model.
# npm hoists the dsh package family to the global root; the script walks
# <root>/node_modules, and for a global install `npm root -g` IS that
# node_modules directory — so it must be handed its parent (/usr/local/lib).
# Fail-closed: the build fails when the script errors or when the browser
# needle drifted upstream (WARN in the log = zero bundles patched).
COPY patches/enable-remote-configuration.mjs /usr/local/lib/dsh-patches/enable-remote-configuration.mjs
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN node /usr/local/lib/dsh-patches/enable-remote-configuration.mjs "$(dirname "$(npm root -g)")" | tee /tmp/patch.log \
    && ! grep -q 'WARN: browser isLoopback pattern not found' /tmp/patch.log

# Reverse-proxy auth trust patch (host half, applied unconditionally at build
# time; inert until the runtime env flag is set). Every Host RPC call, every
# WebSocket stream and the index document itself sit behind one browser-session
# gate: a per-process, shared `?token=` URL mints an HMAC cookie that is bound to
# the exact request authority, so a cleared cookie or a changed authority
# (https hostname vs. LAN ip:port) costs the 401 "dsh web authentication
# required; reopen the URL printed by dsh web" until that URL is opened again.
# A deployment that already authenticates at a reverse proxy therefore carries a
# second gate it cannot use per user or revoke per client. The patch makes the
# gate skippable per deployment (DSH_TRUST_REVERSE_PROXY_AUTH, optionally
# hardened by DSH_PROXY_AUTH_SECRET plus a proxy-injected `x-dsh-proxy-auth`
# header) while the Host/Origin trust fence stays in force. See README "Auth
# behind an authenticating reverse proxy".
# Fail-closed: any `WARN:` in the log (missing package, drifted needle, write
# failure) fails the build, so an upstream bump cannot silently leave the flag
# doing nothing.
COPY patches/trusted-proxy-auth.mjs /usr/local/lib/dsh-patches/trusted-proxy-auth.mjs
RUN node /usr/local/lib/dsh-patches/trusted-proxy-auth.mjs "$(dirname "$(npm root -g)")" | tee /tmp/proxy-auth.log \
    && ! grep -q 'WARN:' /tmp/proxy-auth.log

# Stream stall watchdog patch (both halves, applied unconditionally at build
# time). 0.1.2 already heartbeats the Remote-stream WebSocket on the host, but
# the browser cannot observe ping/pong and reconnects only on socket close, so a
# silently dead downlink still freezes the WebUI until a page reload. The host
# half sends a tiny application keepalive frame next to its ping; the browser
# half drops it and runs a socket-bound stall watchdog that triggers the
# existing reconnect path. See README "WebUI downlink watchdog".
# Fail-closed: any `WARN:` in the log (missing file, drifted needle, write
# failure) fails the build, because either half alone is worse than neither.
COPY patches/stream-stall-watchdog.mjs /usr/local/lib/dsh-patches/stream-stall-watchdog.mjs
RUN node /usr/local/lib/dsh-patches/stream-stall-watchdog.mjs "$(dirname "$(npm root -g)")" | tee /tmp/stall-watchdog.log \
    && ! grep -q 'WARN:' /tmp/stall-watchdog.log

# Network-availability churn patch (client half, applied unconditionally at
# build time). The client aborts its connection generation on every browser
# offline/online event, so the routine `navigator.onLine` flapping of a phone
# (Wi-Fi/cellular handover, radio sleep) costs a full reconnect — the WebUI shows
# the reconnecting indicator although nothing was lost. The patch narrows that
# abort to an attempt that has not delivered a connection yet; an established
# socket now fails on its own instead. See README "Reconnecting indicator".
# The client bundle is composed per request and served cache-busted, so this
# half is live on the next page load — no container rebuild needed to test the
# fix, while the build keeps it reproducible.
COPY patches/network-availability-churn.mjs /usr/local/lib/dsh-patches/network-availability-churn.mjs
RUN node /usr/local/lib/dsh-patches/network-availability-churn.mjs "$(dirname "$(npm root -g)")" | tee /tmp/network-churn.log \
    && ! grep -q 'WARN:' /tmp/network-churn.log

# Brotli compression patch (host half, applied unconditionally at build time).
# The shipped gzip middleware runs at level 1, so every page load pulls 1.64 MB
# for the client plugin bundle although the decoded body is 5.7 MB. The patch
# inserts a brotli seat ahead of the gzip chain: a client offering `br` gets the
# same body in 1.15 MB, every other client keeps the untouched gzip path. See
# README "WebUI transfer size".
# Fail-closed: any `WARN:` in the log (missing file, drifted needle, write
# failure) fails the build, so an upstream bump cannot silently fall back to
# gzip-1 without the build saying so.
COPY patches/brotli-compression.mjs /usr/local/lib/dsh-patches/brotli-compression.mjs
RUN node /usr/local/lib/dsh-patches/brotli-compression.mjs "$(dirname "$(npm root -g)")" | tee /tmp/brotli.log \
    && ! grep -q 'WARN:' /tmp/brotli.log

# Static-asset caching patch (host half, applied unconditionally at build time).
# The dist server answers every asset without cache metadata, so the shell
# (390 KB gzip of JS and CSS) is re-downloaded on every reload. The patch adds
# the cache policy: content-addressed paths immutable, the rendered index
# no-cache, everything else revalidated by an etag and a 304. See README
# "WebUI transfer size".
COPY patches/static-cache-headers.mjs /usr/local/lib/dsh-patches/static-cache-headers.mjs
RUN node /usr/local/lib/dsh-patches/static-cache-headers.mjs "$(dirname "$(npm root -g)")" | tee /tmp/static-cache.log \
    && ! grep -q 'WARN:' /tmp/static-cache.log

# Preview-route auth gate (host half, applied unconditionally at build time).
# The browser-session gate is called only by the index document and the /api
# routes; a preview plugin registers its own prefix route under /preview/<id>
# whose handler owns the whole response and never consults the gate. Measured on
# dsh 0.1.2-rc.1 (2026-09-11): GET /preview/<id>/ answers 200 without a cookie
# and without a token, and it does not even pass the Host/Origin trust fence
# (the same request with a foreign Host also answers 200, while /api answers
# 403). The patch routes HTTP requests and WebSocket upgrades whose pathname is a
# registered /preview prefix through the connection service's own verdict: 401/403
# exactly like /api, 503 when the connection service is absent — there is no open
# mode. Requests outside a registered preview prefix are untouched. See README
# "Previewing a page in the container".
# Must run AFTER the brotli patch: both rewrite dsh-host-webserver/lib/index.js,
# and needle matching is order-sensitive by design (measured: needles stay unique
# in either order, the sequence is pinned to keep it that way).
# Fail-closed: any `WARN:` in the log (needle drift, missing package, malformed
# replacement, write failure) fails the build.
COPY patches/preview-auth-gate.mjs /usr/local/lib/dsh-patches/preview-auth-gate.mjs
RUN node /usr/local/lib/dsh-patches/preview-auth-gate.mjs "$(dirname "$(npm root -g)")" | tee /tmp/preview-gate.log \
    && ! grep -q 'WARN:' /tmp/preview-gate.log

# Preview plugin (show_website), shipped ready to load but NOT registered: no
# profile row is added for the operator. The web profile lives in the dsh-data
# volume and `dsh` never overwrites an initialized profile, so an image can only
# provide the code; the README documents the two lines that activate it in
# $DSH_HOME/profiles/web/cordis.patch.yml.
# Why not registered by default: every layer of a profile is one transactional
# loader update, so a single bad row (import error, missing `apply`, an unmet
# `inject`) makes `dsh web` exit 1 — PID 1 under `restart: unless-stopped`, i.e.
# a crash loop with the volume persistent and nothing served. A plugin that
# tracks internal APIs must not be able to do that to a deployment that never
# asked for it. See README "Previewing a page in the container".
# Location is load-bearing: the profile patch must name the ABSOLUTE path
# (a `./`-relative name would resolve inside the volume).
COPY plugins/show-website /usr/local/share/dsh-plugins/show-website

# Telemetry off by default (upstream flipped the default to FEEDBACK_ONLY).
# Override at runtime with an empty value: DSH_TELEMETRY_DISABLED=
ENV DSH_TELEMETRY_DISABLED=1

# Playwright + Chromium for the agent (web-app testing, screenshots, scraping).
# Global install so library + CLI are on PATH; browsers are version-locked to the
# npm package version, so PLAYWRIGHT_VERSION is pinned like GH_VERSION/DSH_VERSION.
# --with-deps runs apt (needs root) -> must stay before USER node.
# PLAYWRIGHT_BROWSERS_PATH keeps browsers outside volumes, shared and readable for node.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rwX /ms-playwright

# GPU userspace stack for the host iGPU, which compose passes through as /dev/dri.
# Mesa's DRI drivers (iris for Intel Gen8+, i915, swrast) already arrive with
# libgl1-mesa-dri via the Playwright deps above, but the layers that connect a GPU
# client to them are missing:
#   libegl1 + libegl-mesa0 -> Mesa EGL through glvnd (Chromium's ANGLE GL backend)
#   libgles2               -> GLESv2 dispatch for the same path
#   mesa-vulkan-drivers    -> Intel ANV Vulkan ICD (ANGLE's Vulkan backend)
#   vulkan-tools           -> vulkaninfo, for verifying the passthrough
# Without them Chromium cannot open the GPU and renders through SwiftShader (CPU).
# Verify in the running container: node scripts/gpu-check.mjs
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libegl1 libegl-mesa0 libgles2 \
       mesa-vulkan-drivers \
       vulkan-tools \
    && rm -rf /var/lib/apt/lists/*

# GPU default patch (applied unconditionally at build time).
# Chromium picks no hardware backend on its own here: with /dev/dri passed
# through, the device nodes readable and the Intel ICDs installed, a plain
# Playwright launch still reported SwiftShader, while the same launch with
# --use-angle=gl-egl reported the Intel iGPU. No environment variable reaches that
# decision and Playwright offers no env hook for Chromium arguments, so the patch
# appends --use-angle=gl-egl to its default arguments - gated on a runtime check
# that the launching user can open /dev/dri/renderD128. A host without GPU access
# keeps the stock SwiftShader fallback, and a project passing its own
# --use-gl/--use-angle wins. See README "GPU passthrough (Intel iGPU)".
# Fail-closed: any `WARN:` in the log (needle drift, write failure, patched file
# that no longer parses) fails the build.
COPY patches/chromium-gpu-default.mjs /usr/local/lib/dsh-patches/chromium-gpu-default.mjs
RUN node /usr/local/lib/dsh-patches/chromium-gpu-default.mjs "$(dirname "$(npm root -g)")" | tee /tmp/gpu-patch.log \
    && ! grep -q 'WARN' /tmp/gpu-patch.log

ENV DSH_HOME=/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data /workspace \
    && chown -R node:node /data /workspace

USER node
WORKDIR /workspace

EXPOSE 3080

ENTRYPOINT ["docker-entrypoint.sh"]
CMD []
