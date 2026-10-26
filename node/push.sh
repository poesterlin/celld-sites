#!/bin/sh
# Deploy a site bundle (from tools/pack.mjs) to the router, tar'ed on stdin:
#   tar -C <bundle> -cf - . | push.sh <hostname> [--if-new] [--no-check] [--watch SECS]
#  1. upload the files the router doesn't have yet (files are stored once by
#     content hash, shared by all versions), then the code;
#  2. check: run the new version without activating it, its Durable Objects in an
#     empty scratch namespace, and request its check path (celld.json "check",
#     default "/"). A 5xx, an error or a timeout stops the deploy here;
#  3. activate it for the hostname's site;
#  4. watch (default 10 s): probe the check path on the live site every 2 s. On a
#     5xx (e.g. a migration that fails on real data) the previous version is
#     activated again and the deploy fails. Data a new version already changed is
#     not rolled back.
# --if-new leaves a site that already has an active version alone (the answer then
# has "skipped": true) and skips check and watch. Runs inside the celld container,
# where the token lives; prints the activation result.
set -eu
usage="usage: push.sh <hostname> [--if-new] [--no-check] [--watch SECS] < bundle.tar"
host="${1:?$usage}"
shift
if_new= do_check=1 watch=10
while [ $# -gt 0 ]; do
	case "$1" in
	--if-new) if_new="&ifNew=1"; do_check=; watch=0 ;;
	--no-check) do_check=; watch=0 ;;
	--watch) watch="${2:?$usage}"; shift ;;
	*) echo "$usage" >&2; exit 2 ;;
	esac
	shift
done
case "$watch" in *[!0-9]* | "") echo "$usage" >&2; exit 2 ;; esac

umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Pass the token in a curl config file, not on the command line (visible in ps).
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$work/auth"
tar -xf - -C "$work"
version=$(cat "$work/version")
# CELLD_ADMIN_API: the node to deploy to (tools/preview.sh points it at a local one).
base="${CELLD_ADMIN_API:-http://127.0.0.1:8080}"
api="$base/__admin"
call() { curl -sS --fail-with-body -K "$work/auth" -H "Host: $ADMIN_HOST" "$@"; }
log() { echo "push: $*" >&2; }
field() { sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p"; }

# 1. Ask which files are missing, upload those (6 at a time), then the code.
ls "$work/blobs" | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/; s/$/]/' > "$work/hashes.json"
missing=$(call -X POST -H "Content-Type: application/json" --data-binary "@$work/hashes.json" "$api/blobs/missing" | grep -o '[a-f0-9]\{64\}' || true)
log "uploading $(printf '%s' "$missing" | grep -c . || true) of $(ls "$work/blobs" | wc -l) files"
if [ -n "$missing" ]; then
	printf '%s\n' $missing | xargs -P 6 -I {} curl -sS --fail-with-body -o /dev/null -K "$work/auth" -H "Host: $ADMIN_HOST" \
		-X PUT -H "Content-Type: application/octet-stream" --data-binary "@$work/blobs/{}" "$api/blob?hash={}"
fi
call -X PUT -H "Content-Type: application/json" --data-binary "@$work/code.json" "$api/code?version=$version&host=$host" >/dev/null

# 2. Check the new version before anyone sees it.
path=/
if [ -n "$do_check" ]; then
	result=$(call -X POST "$api/check?host=$host&version=$version")
	if printf '%s' "$result" | grep -q '"skipped":true'; then
		log "check skipped (celld.json \"check\": false)"
		watch=0
	elif printf '%s' "$result" | grep -q '"ok":true'; then
		path=$(printf '%s' "$result" | field path)
		log "check passed: $path answered $(printf '%s' "$result" | field status) in $(printf '%s' "$result" | field ms) ms"
	else
		log "check failed, not activated (version $version stays uploaded): $result"
		exit 1
	fi
fi

# 3. Activate.
out=$(call -X POST "$api/activate?host=$host&version=$version$if_new")

# 4. Watch the live site; roll back on a 5xx.
previous=$(printf '%s' "$out" | field previous)
[ "$previous" = null ] && previous=
[ "$previous" = "$version" ] && watch=0
i=0
while [ "$i" -lt "$watch" ]; do
	sleep 2
	i=$((i + 2))
	code=$(curl -s -o "$work/probe" -w '%{http_code}' -m 30 -H "Host: $host" -H "Accept: text/html" "$base$path" || true)
	case "$code" in
	[1-4]??) continue ;;
	esac
	log "live probe of $path answered ${code:-no response}: $(head -c 300 "$work/probe" 2>/dev/null || true)"
	if [ -n "$previous" ]; then
		call -X POST "$api/activate?host=$host&version=$previous" >/dev/null
		log "rolled back to $previous; version $version stays uploaded"
	else
		log "no previous version to roll back to; $version stays active"
	fi
	exit 1
done
[ "$watch" -gt 0 ] && log "live probes of $path passed for $watch s"
printf '%s\n' "$out"
