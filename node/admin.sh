#!/bin/sh
# Call the router's admin API from inside the celld container:
#   admin.sh POST '/prune?keep=3'
#   admin.sh PUT '/alias?host=new.example.com&site=old.example.com'
#   admin.sh DELETE '/alias?host=new.example.com'
#   admin.sh POST '/activate?host=site.example.com&version=0123456789ab'   (rollback)
#   admin.sh GET /overview
set -eu
method="${1:?usage: admin.sh <METHOD> <path>}"
path="${2:?usage: admin.sh <METHOD> <path>}"
umask 077
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$auth"
curl -sS --fail-with-body -K "$auth" -X "$method" -H "Host: $ADMIN_HOST" "http://127.0.0.1:8080/__admin$path"
echo
