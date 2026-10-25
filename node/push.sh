#!/bin/sh
# Deploy a site bundle (from tools/pack.mjs) to the router, tar'ed on stdin:
#   tar -C <bundle> -cf - . | push.sh <hostname>
# Uploads each file, then the code, then activates the version for the
# hostname's site. Runs inside the celld container, where the token lives.
set -eu
host="${1:?usage: push.sh <hostname> < bundle.tar}"

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Pass the token in a curl config file, not on the command line (visible in ps).
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$work/auth"
tar -xf - -C "$work"
version=$(cat "$work/version")
# CELLD_ADMIN_API: the node to deploy to (tools/preview.sh points it at a local one).
api="${CELLD_ADMIN_API:-http://127.0.0.1:8080}/__admin"
call() { curl -sS --fail-with-body -K "$work/auth" -H "Host: $ADMIN_HOST" "$@"; }

tab=$(printf '\t')
while IFS="$tab" read -r n type path; do
	[ -n "$n" ] || continue
	call -X PUT -H "Content-Type: $type" --data-binary "@$work/files/$n" \
		"$api/asset?version=$version&path=$path" >/dev/null
done < "$work/files.tsv"

call -X PUT -H "Content-Type: application/json" --data-binary "@$work/code.json" "$api/code?version=$version" >/dev/null
call -X POST "$api/activate?host=$host&version=$version"
echo
