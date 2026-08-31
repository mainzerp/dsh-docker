# dsh-docker image: DeepSeek Harness built from upstream source.
#
# dsh is no longer distributed via npm (nothing newer than 0.1.1-rc.2), so the
# builder stage fetches the upstream git-tag tarball and packs the release
# tarballs exactly like upstream's own release pipeline (release:pack +
# verify-packed-install model). DSH_VERSION is a git TAG name (dsh-v*).
#
# Build requirements: >= ~6 GB RAM and roughly 15-30 min for a cold build
# (250+ workspace packages; upstream CI reference: ~7 min warm-cache for the
# source build alone).

# ---------------------------------------------------------------------------
# Builder stage: fetch the upstream tag, build, and pack release tarballs.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS dsh-build

ARG DSH_VERSION=dsh-v0.1.2-alpha.3

# musl-tools: static musl build of landlock-run (sandbox runner, D6).
RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools \
    && rm -rf /var/lib/apt/lists/*

# pnpm pin matches upstream packageManager (root package.json).
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /src

# Fetch the git tag tarball (codeload). curl -f fails the build on a bad tag.
RUN curl -fsSL "https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/tags/${DSH_VERSION}" \
    | tar xz --strip-components=1 -C /src

# The tarball has no .git, but the official build needs a commit hash
# (scripts/client-build-environment.ts accepts the DSH_CLIENT_COMMIT_HASH env
# override). Resolve it from the tag ref: peeled (annotated) first, then the
# unpeeled (lightweight) ref.
RUN set -e; \
    hash=$(git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git "refs/tags/${DSH_VERSION}^{}" | awk '{print $1}'); \
    if [ -z "$hash" ]; then \
        hash=$(git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git "refs/tags/${DSH_VERSION}" | awk '{print $1}'); \
    fi; \
    echo "$hash" | grep -Eq '^[0-9a-f]{40}$' || { echo "failed to resolve a commit for tag ${DSH_VERSION}" >&2; exit 1; }; \
    echo "$hash" > /src/.dsh-commit-hash \
    && echo "resolved ${DSH_VERSION} -> ${hash}"

# CI=true neutralizes the lefthook installer in the root postinstall.
ENV CI=true

RUN pnpm install --frozen-lockfile

# build:official is mandatory before release:pack --family dsh (build-record
# assertion). The pack step re-derives the official environment, so the commit
# hash must be exported for both.
RUN set -e; \
    export DSH_CLIENT_COMMIT_HASH="$(cat /src/.dsh-commit-hash)"; \
    pnpm run build:official; \
    pnpm run release:pack --family dsh --out dist/npm --concurrency 8; \
    pnpm run release:pack --family vendor --out dist/npm-vendor --concurrency 8

# landlock-run: TypeScript entry + static musl binary, packed for THIS
# platform only (npm pack preserves the exec bit; pnpm pack strips it).
RUN pnpm --dir native/landlock-run run build \
    && pnpm --dir native/landlock-run run build:native
RUN cd native/landlock-run \
    && node scripts/pack-release.mjs /src/dist/npm-landlock --current-platform-only

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:24-bookworm

# --- System tools ---
# Base image (buildpack-deps:bookworm) already provides: gcc, g++, make, dpkg-dev,
# git, curl, ca-certificates, wget, gnupg, openssh-client, procps, imagemagick, file,
# patch, unzip, xz-utils, and the common -dev libraries. Do NOT reinstall those.
# socat: TCP forwarder, because `dsh web` intentionally does not support --host 0.0.0.0
# bubblewrap: sandbox runner for agent subprocesses (preferred; landlock-run
#   built in the builder stage is the fallback)
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

# --- dsh install from the packed tarballs ---
# file:-consumer install, modeled on upstream's verify-packed-install.ts: every
# tarball is a direct file: dependency, so the landlock platform package
# installs despite --omit=optional (which still guards unrelated optional deps).
COPY --from=dsh-build /src/dist/npm /opt/dsh/packed/npm
COPY --from=dsh-build /src/dist/npm-vendor /opt/dsh/packed/npm-vendor
COPY --from=dsh-build /src/dist/npm-landlock /opt/dsh/packed/npm-landlock
COPY scripts/make-consumer-manifest.mjs /usr/local/lib/dsh-build/
COPY patches/enable-remote-configuration.mjs /usr/local/lib/dsh-patches/
RUN node /usr/local/lib/dsh-build/make-consumer-manifest.mjs /opt/dsh/package.json \
        /opt/dsh/packed/npm /opt/dsh/packed/npm-vendor /opt/dsh/packed/npm-landlock \
    && cd /opt/dsh \
    && npm install --no-audit --no-fund --package-lock=false --omit=optional

# Build-time verifications — fail the image build on regression:
# 1. the installed CLI runs and reports its version (tracks DSH_VERSION),
# 2. the landlock-run binary for this architecture is present and executable,
# 3. the remote-configuration patch applies to at least one client bundle
#    (grep-gate: the build fails when the browser needle drifts upstream).
RUN set -e; \
    version=$(node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version); \
    echo "installed dsh version: ${version}"; \
    case "$(uname -m)" in \
        x86_64) plat=linux-x64 ;; \
        aarch64) plat=linux-arm64 ;; \
        *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    test -x "/opt/dsh/node_modules/@deepseek-ai/node-addon-landlock-run-${plat}/bin/landlock-run"; \
    node /usr/local/lib/dsh-patches/enable-remote-configuration.mjs /opt/dsh > /tmp/patch.log 2>&1 \
        || { cat /tmp/patch.log; exit 1; }; \
    cat /tmp/patch.log; \
    ! grep -q 'WARN: browser isLoopback pattern not found' /tmp/patch.log

# Tarballs are only install sources — drop them from the final image.
RUN rm -rf /opt/dsh/packed

# Expose the dsh bin symlink from the consumer install.
ENV PATH="/opt/dsh/node_modules/.bin:${PATH}"

# Telemetry off by default (upstream flipped the default to FEEDBACK_ONLY).
# Override at runtime with an empty value: DSH_TELEMETRY_DISABLED=
ENV DSH_TELEMETRY_DISABLED=1

# Playwright + Chromium for the agent (web-app testing, screenshots, scraping).
# Global install so library + CLI are on PATH; browsers are version-locked to the
# npm package version, so PLAYWRIGHT_VERSION is pinned like GH_VERSION.
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
