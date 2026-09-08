#!/bin/sh
set -e

# `dsh web` intentionally binds only to 127.0.0.1 (--host 0.0.0.0 is not supported).
# To make Docker port mapping work, socat forwards the external port to the
# internal loopback address where dsh listens.
INTERNAL_PORT="${DSH_INTERNAL_PORT:-3081}"
EXTERNAL_PORT="${DSH_PORT:-3080}"

socat "TCP-LISTEN:${EXTERNAL_PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${INTERNAL_PORT}" &

# The /api trust fence only accepts explicitly named authorities (Host header).
# TRUSTED_HOSTS: comma-separated list, e.g. "192.168.1.10:3080,myhost:3080"
TRUSTED_ARGS=""
if [ -n "${TRUSTED_HOSTS:-}" ]; then
    OLD_IFS=$IFS
    IFS=','
    for host in $TRUSTED_HOSTS; do
        host=$(printf '%s' "$host" | tr -d '[:space:]')
        if [ -n "$host" ]; then
            TRUSTED_ARGS="$TRUSTED_ARGS --trusted-host $host"
        fi
    done
    IFS=$OLD_IFS
fi

# Token URL surfacing: since 0.1.2 the WebUI requires a per-launch token, which
# dsh prints once at readiness as `dsh web: http://127.0.0.1:<port>?token=...`
# (optionally with a " (LAN: ...)" suffix). That internal authority is useless
# from outside the container, so a watcher tees dsh's output to the container
# stdout and reprints the readiness line with the external authorities
# (localhost:$DSH_PORT + every TRUSTED_HOSTS entry).
#
# Accepted risk: if the watcher subshell dies, dsh blocks on fifo writes. The
# watcher is a minimal read/printf loop; the manual fallback
# (`docker logs dsh | grep 'dsh web:'`) is documented in the README.
FIFO="${TMPDIR:-/tmp}/dsh-web-log.$$"
rm -f "$FIFO"
(umask 077; mkfifo "$FIFO")

(
    while IFS= read -r line; do
        printf '%s\n' "$line"
        case "$line" in
        "dsh web: http"*)
            url=${line#"dsh web: "}
            url=${url%% *}        # drop the optional " (LAN: ...)" suffix
            query=${url#*\?}      # token query string
            if [ "$query" != "$url" ]; then
                printf 'dsh web (external): http://localhost:%s?%s\n' "$EXTERNAL_PORT" "$query"
                if [ -n "${TRUSTED_HOSTS:-}" ]; then
                    OLD_IFS=$IFS
                    IFS=','
                    for host in $TRUSTED_HOSTS; do
                        host=$(printf '%s' "$host" | tr -d '[:space:]')
                        if [ -n "$host" ]; then
                            printf 'dsh web (external): http://%s?%s\n' "$host" "$query"
                        fi
                    done
                    IFS=$OLD_IFS
                fi
            fi
            ;;
        esac
    done < "$FIFO"
) &

# --no-open: there is no browser inside the container; the flag also silences
# the browser-handoff diagnostic upstream prints otherwise.
# exec: dsh becomes PID 1 and receives SIGTERM directly (graceful drain up to 5s).
# shellcheck disable=SC2086
exec dsh web --no-open --port "$INTERNAL_PORT" $TRUSTED_ARGS "$@" >"$FIFO" 2>&1
