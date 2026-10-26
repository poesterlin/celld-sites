#!/bin/sh
# Deploy a site bundle (from tools/pack.mjs) to the router, tar'ed on stdin:
#   tar -C <bundle> -cf - . | push.sh <hostname> [--if-new]
# Uploads the files the router doesn't have yet (files are stored once by
# content hash, shared by all versions), then the code, then activates the
# version for the hostname's site. --if-new leaves a site that already has an active version
# alone (the answer then has "skipped": true). Runs inside the celld container,
# where the token lives.
set -eu
host="${1:?usage: push.sh <hostname> [--if-new] < bundle.tar}"
if_new=
case "${2:-}" in
"") ;;
--if-new) if_new="&ifNew=1" ;;
*) echo "usage: push.sh <hostname> [--if-new] < bundle.tar" >&2; exit 2 ;;
esac

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

# Ask which files are missing, then upload those, 6 at a time.
ls "$work/blobs" | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/; s/$/]/' > "$work/hashes.json"
missing=$(call -X POST -H "Content-Type: application/json" --data-binary "@$work/hashes.json" "$api/blobs/missing" | grep -o '[a-f0-9]\{64\}' || true)
echo "push: uploading $(printf '%s' "$missing" | grep -c . || true) of $(ls "$work/blobs" | wc -l) files" >&2
if [ -n "$missing" ]; then
	printf '%s\n' $missing | xargs -P 6 -I {} curl -sS --fail-with-body -o /dev/null -K "$work/auth" -H "Host: $ADMIN_HOST" \
		-X PUT -H "Content-Type: application/octet-stream" --data-binary "@$work/blobs/{}" "$api/blob?hash={}"
fi

call -X PUT -H "Content-Type: application/json" --data-binary "@$work/code.json" "$api/code?version=$version&host=$host" >/dev/null
call -X POST "$api/activate?host=$host&version=$version$if_new"
echo
