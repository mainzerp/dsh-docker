FROM node:24-bookworm

# --- System tools ---
# Base image (buildpack-deps:bookworm) already provides: gcc, g++, make, dpkg-dev,
# git, curl, ca-certificates, wget, gnupg, openssh-client, procps, imagemagick, file,
# patch, unzip, xz-utils, and the common -dev libraries. Do NOT reinstall those.
# socat: TCP forwarder, because `dsh web` intentionally does not support --host 0.0.0.0
# bubblewrap: sandbox runner for agent subprocesses (preferred; the landlock-run
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
# Default install (no --omit=optional): the landlock-run launcher ships as a
# platform-restricted optional dep of @deepseek-ai/node-addon-landlock-run (a
# plain dependency of @deepseek-ai/dsh-sandbox-local), so the sandbox fallback
# binary comes in with the regular install.
# npm 11 blocks dependency install scripts by default; that is harmless on
# linux/x64 (node-pty ships its prebuild in the tarball, koffi uses its
# @koromix/koffi-linux-x64 optional prebuild, ensure-spawn-helper is a no-op).
ARG DSH_VERSION=0.1.2-rc.1
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
# npm hoists the dsh package family to the global root, so the script runs
# against $(npm root -g) (it walks <root>/node_modules), NOT the dsh package
# directory. Fail-closed: the build fails when the script errors or when the
# browser needle drifted upstream (WARN in the log = zero bundles patched).
COPY patches/enable-remote-configuration.mjs /usr/local/lib/dsh-patches/enable-remote-configuration.mjs
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN node /usr/local/lib/dsh-patches/enable-remote-configuration.mjs "$(npm root -g)" | tee /tmp/patch.log \
    && ! grep -q 'WARN: browser isLoopback pattern not found' /tmp/patch.log

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
