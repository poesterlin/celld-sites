#!/bin/sh
# Local preview of a site, running exactly as in production: the production
# router under `celld dev` on this machine (same isolation, bindings and runtime
# patches), with the site deployed into it. Local data persists between runs in
# <site>/.celld-preview (gitignored), including the node log (celld.log).
# Needs celld on PATH (~/.local/bin) and the site's npm dependencies installed.
#
#   tools/preview.sh <site-dir> [port]   build, start the local node if needed, deploy
#   tools/preview.sh <site-dir> --stop   stop the local node
#   tools/preview.sh <site-dir> --reset  stop and delete the local data
#
# The preview answers on any hostname (http://localhost:<port>/ by default).
# PREVIEW_HOST=0.0.0.0 makes it reachable from other machines on the network.
# Seed it with: tools/seed.ts --preview <site-dir> <seed.json>
set -eu
usage="usage: tools/preview.sh <site-dir> [port|--stop|--reset]"
site=$(cd "${1:?$usage}" && pwd)
arg="${2:-8790}"
project=$(cd "$(dirname "$0")/.." && pwd)
state="$site/.celld-preview"
mkdir -p "$state"

stop() {
	[ -f "$state/pid" ] || { echo "preview not running"; return 0; }
	pid=$(cat "$state/pid")
	if kill -0 "$pid" 2>/dev/null; then
		# celld dev runs the node as a child process; stop both, by PID.
		pkill -TERM -P "$pid" 2>/dev/null || true
		kill -TERM "$pid" 2>/dev/null || true
		i=0
		while kill -0 "$pid" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
		kill -0 "$pid" 2>/dev/null && { pkill -KILL -P "$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; }
	fi
	rm -f "$state/pid" "$state/port"
	echo "preview stopped"
}

case "$arg" in
--stop) stop; exit 0 ;;
--reset) stop; rm -rf "$state/router/.celld"; echo "preview data deleted"; exit 0 ;;
*[!0-9]*) echo "$usage" >&2; exit 1 ;;
esac
port="$arg"

# celld bundles the router with esbuild: the site's own, else the tools' copy.
PATH="$site/node_modules/.bin:$project/tools/node_modules/.bin:$HOME/.local/bin:$PATH"
command -v celld >/dev/null || { echo "celld not found (install it to ~/.local/bin)" >&2; exit 1; }
command -v esbuild >/dev/null || { echo "esbuild not found: run 'npm ci --prefix tools' once" >&2; exit 1; }

# A local-only admin token. The router gets its hash, as in production.
umask 077
[ -s "$state/token" ] || head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40 > "$state/token"
token=$(cat "$state/token")
hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)

# The router app, regenerated each run so router changes are picked up on restart.
mkdir -p "$state/router"
cp -r "$project/router/." "$state/router/"
sed -e "s/@ADMIN_TOKEN_SHA256@/$hash/" -e "s/@READ_TOKEN_SHA256@/$hash/" \
	-e "s/@ADMIN_HOST@/admin.internal/" -e "s/@DEFAULT_SITE@/preview/" -e "s/@OPERATOR_URL@//" -e "s/@SITE_TIMEOUT_SECS@/30/" \
	-e "s/@SITE_MAX_INFLIGHT@/${SITE_MAX_INFLIGHT:-128}/" -e "s/@SITE_MAX_OBJECTS@/${SITE_MAX_OBJECTS:-1000}/" -e "s/@SITE_MAX_SUBREQUESTS@/${SITE_MAX_SUBREQUESTS:-1000}/" \
	-e "s/@PROXY_TOKEN_SHA256@//" -e "s/@PROXY_SITE_PREFIX@//" \
	"$project/router/wrangler.template.json" > "$state/router/wrangler.json"

health() { curl -sf -o /dev/null "http://127.0.0.1:$port/.well-known/celld/health"; }
if ! { [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null && health; }; then
	health && { echo "port $port is used by something else" >&2; exit 1; }
	echo "starting local node on port $port"
	# Own session (setsid), so the node keeps running after this script exits.
	setsid sh -c 'cd "$1" && exec celld dev --port "$2" --host "$3" --no-watch --logs' sh \
		"$state/router" "$port" "${PREVIEW_HOST:-127.0.0.1}" > "$state/celld.log" 2>&1 < /dev/null &
	echo $! > "$state/pid"
	echo "$port" > "$state/port"
	i=0
	until health; do
		i=$((i + 1))
		[ $i -gt 90 ] && { echo "local node did not start; see $state/celld.log" >&2; tail -5 "$state/celld.log" >&2; exit 1; }
		sleep 1
	done
fi

bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
# Build if the site has a build script; a plain static folder is deployed as is.
if [ -f "$site/package.json" ] && grep -q '"build"[[:space:]]*:' "$site/package.json"; then
	(cd "$site" && npm run build >/dev/null)
fi
node "$project/tools/pack.ts" "$site" "$bundle"
tar -C "$bundle" -cf - . |
	ADMIN_TOKEN="$token" ADMIN_HOST=admin.internal CELLD_ADMIN_API="http://127.0.0.1:$port" sh "$project/node/push.sh" preview --watch 0 >/dev/null
echo "preview: http://localhost:$port/"
