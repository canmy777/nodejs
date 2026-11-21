#!/bin/sh
set -eu

cd /home/container
umask 077

memory_limit=''
for cgroup_file in \
    /sys/fs/cgroup/memory.max \
    /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$cgroup_file" ]; then
        memory_limit=$(cat "$cgroup_file" 2>/dev/null || true)
        [ -n "$memory_limit" ] && break
    fi
done

case "$memory_limit" in
    ''|max|*[!0-9]*)
        echo '[Startup] cgroup memory limit unavailable; using Node.js container-aware default'
        exec /usr/local/bin/node /home/container/index.js
        ;;
esac

# Some cgroup v1 runtimes report a huge sentinel value for unlimited memory.
if [ "$memory_limit" -gt 1099511627776 ] 2>/dev/null; then
    echo '[Startup] cgroup memory is unlimited; using Node.js default heap'
    exec /usr/local/bin/node /home/container/index.js
fi

memory_mb=$((memory_limit / 1048576))
heap_mb=$((memory_mb * 70 / 100))
if [ "$heap_mb" -lt 16 ]; then
    echo '[Startup] detected memory limit is too small for a safe V8 heap' >&2
    exit 1
fi

echo "[Startup] cgroup limit=${memory_mb}MiB; V8 old-space=${heap_mb}MiB (70%)"
exec /usr/local/bin/node --max-old-space-size="$heap_mb" /home/container/index.js
