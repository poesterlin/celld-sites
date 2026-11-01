#!/bin/sh
# Deploy a built site to the running router:
#   tools/deploy.sh <site-dir> <hostname> [--build] [--no-check] [--watch SECS]
# The site must already be built (npm run build in its folder); --build runs the
# build first. The site needs a celld.json (or the SvelteKit adapter-cloudflare layout), see
# docs/SITES.md. The hostname must be the site id, not an alias (an alias is
# refused; deploy to the site id instead). The hostname must also match the
# Traefik rule (SITES_RULE in .env) to be reachable. The new version is checked
# before and watched after activation (see node/push.sh); the options are passed
# on to it.
#
# CELLD_COMPOSE_DIR points the deploy at another compose project (e.g. the
# pull-only production checkout) instead of
# this checkout. The project name, and therefore the volumes, stay the same.
set -eu
site="${1:?usage: tools/deploy.sh <site-dir> <hostname>}"
host="${2:?usage: tools/deploy.sh <site-dir> <hostname>}"
shift 2
project="${CELLD_COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT

# Deploys what is on disk. --build is the explicit opt-in to build first (a site
# without a build script, like a plain static folder, is deployed as is).
build=0
for arg; do
	shift
	if [ "$arg" = --build ]; then build=1; else set -- "$@" "$arg"; fi
done
if [ "$build" = 1 ] && [ -f "$site/package.json" ] && grep -q '"build"[[:space:]]*:' "$site/package.json"; then
	(cd "$site" && npm run build >/dev/null)
fi
node "$project/tools/pack.ts" "$site" "$bundle"
tar -C "$bundle" -cf - . | docker compose --project-directory "$project" exec -T celld /app/push.sh "$host" "$@"
