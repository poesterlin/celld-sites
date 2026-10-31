#!/bin/sh
# ON_CERT_CHANGE of the names agent. Same hostname: reload Caddy so it serves
# the renewed certificate. New hostname (the name was released and registered
# again): Hamstr and Caddy were started for the old one, so restart everything.
set -eu
. /tmp/caddy.env
if [ "$(cat /data/tls/hostname)" != "$TLS_HOSTNAME" ]; then
	echo "appliance: hostname changed to $(cat /data/tls/hostname); restarting" >&2
	kill -USR1 "$(cat /tmp/supervisor.pid)"
	exit 0
fi
exec caddy reload --force --config /app/caddy/tls.caddy --adapter caddyfile --address unix//tmp/caddy-admin.sock
