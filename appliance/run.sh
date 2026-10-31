#!/bin/bash
# Entrypoint. As a Home Assistant add-on, settings come from /data/options.json
# and /data is a root-owned directory: read the options, hand /data to the
# celld user, and drop root. Anywhere else (plain Docker, already non-root)
# this just starts the supervisor.
set -euo pipefail
if [ -f /data/options.json ]; then
	eval "$(node /app/ha-options.mjs /data/options.json)"
fi
if [ "$(id -u)" = 0 ]; then
	[ "$(stat -c %u /data)" = 10001 ] || chown -R 10001:10001 /data
	exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all /app/start.sh
fi
exec /app/start.sh
