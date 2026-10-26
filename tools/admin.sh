#!/bin/sh
# Router admin API from the host, e.g.:
#   tools/admin.sh POST '/prune?keep=3'                                   delete old versions
#   tools/admin.sh PUT '/alias?host=new.example.com&site=old.example.com'  serve a site under another name
#   tools/admin.sh DELETE '/alias?host=new.example.com'
#   tools/admin.sh POST '/activate?host=a.example.com&version=<id>'        roll back to a stored version
#   tools/admin.sh DELETE '/site?id=a.example.com&confirm=a.example.com'  delete a site and its data
set -eu
project=$(cd "$(dirname "$0")/.." && pwd)
docker compose --project-directory "$project" exec -T celld /app/admin.sh "$@"
