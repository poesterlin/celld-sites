#!/bin/sh
# Deploy a site version to the router: push.sh <hostname> < payload.json
# Runs inside the celld container, where the admin hostname and token live.
set -eu
host="${1:?usage: push.sh <hostname> < payload.json}"

umask 077
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
# Pass the token in a curl config file, not on the command line (visible in ps).
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$auth"

curl -sS --fail-with-body -K "$auth" -X POST \
	-H "Host: $ADMIN_HOST" -H "Content-Type: application/json" \
	--data-binary @- "http://127.0.0.1:8080/__admin/deploy?host=$host"
echo
