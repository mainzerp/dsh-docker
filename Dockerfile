FROM node:24-bookworm

# --- System tools ---
# Base image (buildpack-deps:bookworm) already provides: gcc, g++, make, dpkg-dev,
# git, curl, ca-certificates, wget, gnupg, openssh-client, procps, imagemagick, file,
# patch, unzip, xz-utils, and the common -dev libraries. Do NOT reinstall those.
# socat: TCP forwarder, because `dsh web` intentionally does not support --host 0.0.0.0
# python3/-venv/-pip: baseline Python 3.11 (bookworm); system pip is PEP 668
#   "externally managed" — use venvs (or uv) for package installs
# jq, ripgrep, ffmpeg: universal CLI tools for the agent
# tree, less, vim-tiny, tmux, htop, rsync, sqlite3, zip: small standard utilities
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       socat \
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

ARG DSH_VERSION=latest
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

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
