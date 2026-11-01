#!/bin/sh
# Router admin API from the host, e.g.:
#   tools/admin.sh POST '/prune?keep=3&confirm=prune'                                   delete old versions
#   tools/admin.sh PUT '/alias?host=new.example.com&site=old.example.com'  serve a site under another name
#   tools/admin.sh DELETE '/alias?host=new.example.com'
#   tools/admin.sh POST '/activate?host=a.example.com&version=<id>'        roll back to a stored version
#   tools/admin.sh DELETE '/site?id=a.example.com&confirm=a.example.com'  delete a site and its data
#   printf '["api.example.com"]\n' | tools/admin.sh PUT '/egress?host=a.example.com' -  allow outbound fetch()
#   tools/admin.sh GET '/dump?host=a.example.com' > a.backup               back up a site's objects
#   tools/admin.sh POST '/restore?host=a.example.com&confirm=a.example.com' - < a.backup  put them back
#
# CELLD_COMPOSE_DIR selects another compose project (e.g. the pull-only
# production checkout).
set -eu
project="${CELLD_COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
docker compose --project-directory "$project" exec -T celld /app/admin.sh "$@"
