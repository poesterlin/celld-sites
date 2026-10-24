#!/bin/sh
# Build a SvelteKit site and deploy it to the running router:
#   tools/deploy.sh <site-dir> <hostname>
# The site must use @sveltejs/adapter-cloudflare. The hostname also needs a
# Traefik route (SITES_RULE in .env) to be reachable.
set -eu
site="${1:?usage: tools/deploy.sh <site-dir> <hostname>}"
host="${2:?usage: tools/deploy.sh <site-dir> <hostname>}"
project=$(cd "$(dirname "$0")/.." && pwd)

(cd "$site" && npm run build >/dev/null)
node "$project/tools/pack.mjs" "$site" |
	docker compose --project-directory "$project" exec -T celld /app/push.sh "$host"
