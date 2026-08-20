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

# exec: dsh becomes PID 1 and receives SIGTERM directly (graceful drain up to 5s).
# shellcheck disable=SC2086
exec dsh web --port "$INTERNAL_PORT" $TRUSTED_ARGS "$@"
