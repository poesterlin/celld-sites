#!/bin/sh
# Call the router's admin API (inside the celld container, or via tools/):
#   admin.sh POST '/prune?keep=3&confirm=prune'
#   admin.sh PUT '/alias?host=new.example.com&site=old.example.com'
#   admin.sh DELETE '/alias?host=new.example.com'
#   admin.sh POST '/activate?host=site.example.com&version=0123456789ab'   (rollback)
#   admin.sh GET /overview
#   admin.sh DELETE '/site?id=site.example.com&confirm=site.example.com[&aliases=delete]'
#   printf '["api.example.com"]\n' | admin.sh PUT '/egress?host=site.example.com' -   allow outbound fetch()
#   echo '[["hello"]]' | admin.sh POST '/call?host=h&class=Notes&name=main&method=add' -
# A trailing "-" sends stdin as the request body. CELLD_ADMIN_API selects the node.
set -eu
method="${1:?usage: admin.sh <METHOD> <path> [-]}"
path="${2:?usage: admin.sh <METHOD> <path> [-]}"
umask 077
auth=$(mktemp)
trap 'rm -f "$auth"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN" > "$auth"
api="${CELLD_ADMIN_API:-http://127.0.0.1:8080}/__admin"
if [ "${3:-}" = "-" ]; then
	curl -sS --fail-with-body -K "$auth" -X "$method" -H "Host: $ADMIN_HOST" -H "Content-Type: application/json" --data-binary @- "$api$path"
else
	curl -sS --fail-with-body -K "$auth" -X "$method" -H "Host: $ADMIN_HOST" "$api$path"
fi
echo
