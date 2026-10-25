#!/bin/sh
# Build a site and deploy it to the running router:
#   tools/deploy.sh <site-dir> <hostname>
# The site needs a celld.json (or the SvelteKit adapter-cloudflare layout), see
# docs/SITES.md. Deploying to a hostname that is an alias deploys its site. The
# hostname also needs a Traefik route (SITES_RULE in .env) to be reachable.
set -eu
site="${1:?usage: tools/deploy.sh <site-dir> <hostname>}"
host="${2:?usage: tools/deploy.sh <site-dir> <hostname>}"
project=$(cd "$(dirname "$0")/.." && pwd)
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT

# Build if the site has a build script; a plain static folder is deployed as is.
if [ -f "$site/package.json" ] && grep -q '"build"[[:space:]]*:' "$site/package.json"; then
	(cd "$site" && npm run build >/dev/null)
fi
node "$project/tools/pack.mjs" "$site" "$bundle"
tar -C "$bundle" -cf - . | docker compose --project-directory "$project" exec -T celld /app/push.sh "$host"
