#!/bin/sh
# Restore drill: prove that a bucket volume alone is enough to bring every site
# back. Copies the volume into a throwaway one, starts a throwaway VersityGW and
# celld node on it (default bridge, no ports, sharing one network namespace),
# then checks that every site answers its check path below 500 and that the
# node sees the same sites, objects and versions as the source. Removes
# everything afterwards; the source volume is only read.
#
#   tools/restore-drill.sh [--pause] [--calls FILE] [volume]
#                                       default volume: celld-sites_s3-data (live)
#
# A 200 does not prove data came back (an empty database renders too). --calls
# runs read-only object methods on both the live node and the drill node and
# compares the results: a JSON array of { "host", "class", "name", "method" },
# e.g. the examples' export() methods. Only compare objects nothing writes to
# meanwhile, or the live side may have moved on.
#
# To drill a VM backup, restore the volume from the backup under another name
# first and pass that name. Copying the live volume while sites write is not an
# atomic snapshot (a VM backup is); --pause pauses the live s3 container during
# the copy (writes stall for those seconds) to get one.
set -eu
project="${CELLD_COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# The image the live stack runs; override when drilling the pull-only
# production stack in ../celld-sites-deploy (e.g.
# CELLD_NODE_IMAGE=ghcr.io/poesterlin/celld-sites-node:latest).
image="${CELLD_NODE_IMAGE:-celld-sites-node}"
pause= calls=
source=celld-sites_s3-data
usage="usage: tools/restore-drill.sh [--pause] [--calls FILE] [volume]"
while [ $# -gt 0 ]; do
	case "$1" in
	--pause) pause=1 ;;
	--calls) calls="${2:?$usage}"; shift; [ -f "$calls" ] || { echo "no file $calls" >&2; exit 2; } ;;
	-*) echo "$usage" >&2; exit 2 ;;
	*) source=$1 ;;
	esac
	shift
done
docker volume inspect "$source" >/dev/null
id="celld-drill-$$"
log() { echo "drill: $*" >&2; }
cleanup() {
	docker rm -f "$id-node" "$id-s3" >/dev/null 2>&1 || true
	docker volume rm "$id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
rand() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }

log "copying $source"
docker volume create "$id" >/dev/null
[ -n "$pause" ] && docker compose --project-directory "$project" pause s3 >/dev/null
docker run --rm --network none -v "$source:/from:ro" -v "$id:/to" --user 0 --entrypoint sh "$image" \
	-c 'cp -a /from/. /to/ && du -sh /to | cut -f1' || { [ -n "$pause" ] && docker compose --project-directory "$project" unpause s3; exit 1; }
[ -n "$pause" ] && docker compose --project-directory "$project" unpause s3 >/dev/null

# Fresh credentials and tokens: VersityGW's root user comes from its environment,
# and the node redeploys the router (with these token hashes) on start.
s3key=$(rand) s3secret=$(rand)
log "starting a throwaway object store and node"
docker run -d --name "$id-s3" --network bridge --cap-drop ALL --security-opt no-new-privileges \
	-e VGW_BACKEND=posix -e VGW_BACKEND_ARG=/data -e ROOT_ACCESS_KEY_ID="$s3key" -e ROOT_SECRET_ACCESS_KEY="$s3secret" \
	-v "$id:/data" versity/versitygw:v1.10.0 >/dev/null
docker run -d --name "$id-node" --network "container:$id-s3" --init --cap-drop ALL --security-opt no-new-privileges \
	-e CELLD_BUCKET=s3://celld -e S3_ENDPOINT=http://127.0.0.1:7070 -e AWS_REGION=us-east-1 \
	-e AWS_ACCESS_KEY_ID="$s3key" -e AWS_SECRET_ACCESS_KEY="$s3secret" \
	-e ADMIN_TOKEN="$(rand)" -e READ_TOKEN="$(rand)" -e ADMIN_HOST=admin.internal -e EXAMPLE_HOST=drill.invalid \
	-e SITE_MAX_INFLIGHT="${SITE_MAX_INFLIGHT:-128}" -e SITE_MAX_OBJECTS="${SITE_MAX_OBJECTS:-1000}" \
	-e SITE_MAX_SUBREQUESTS="${SITE_MAX_SUBREQUESTS:-1000}" \
	"$image" >/dev/null
i=0
# Wait for the node itself, not for a bundled-site log line: the production
# (hosting) image bundles no sites, so there is nothing to deploy.
until docker exec "$id-node" curl -sf -o /dev/null http://127.0.0.1:8080/.well-known/celld/health 2>/dev/null; do
	i=$((i + 1))
	[ $i -gt 120 ] && { log "node did not start"; docker logs --tail 20 "$id-node" >&2; exit 1; }
	sleep 1
done

summary() { python3 -c '
import json, sys
o = json.load(sys.stdin)
print(json.dumps({"sites": sorted(s["id"] for s in o["sites"] if s["id"] != "drill.invalid"),
                  "objects": len([x for x in o["objects"] if x["site"] != "drill.invalid"]),
                  "versions": len(o["versions"])}))'; }
live=$(docker compose --project-directory "$project" exec -T celld /app/admin.sh GET /overview | summary)
drill=$(docker exec "$id-node" /app/admin.sh GET /overview | summary)
log "live:  $live"
log "drill: $drill"
fail=0
[ "$source" = celld-sites_s3-data ] && [ "$live" != "$drill" ] && { log "MISMATCH (sites may have changed since the copy)"; fail=1; }

for site in $(printf '%s' "$drill" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["sites"]))'); do
	code=$(docker exec "$id-node" curl -s -o /dev/null -w '%{http_code}' -m 30 -H "Host: $site" -H "Accept: text/html" http://127.0.0.1:8080/)
	case "$code" in [1-4]??) log "ok    $site: $code" ;; *) log "FAIL  $site: $code"; fail=1 ;; esac
done
if [ -n "$calls" ]; then
	for c in $(python3 -c 'import json,sys,urllib.parse as u; [print(u.urlencode({"host":c["host"],"class":c["class"],"name":c["name"],"method":c["method"]})) for c in json.load(open(sys.argv[1]))]' "$calls"); do
		a=$(echo '[]' | docker compose --project-directory "$project" exec -T celld /app/admin.sh POST "/call?$c" - | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("result"), sort_keys=True))')
		b=$(echo '[]' | docker exec -i "$id-node" /app/admin.sh POST "/call?$c" - | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("result"), sort_keys=True))')
		label=$(printf '%s' "$c" | sed 's/&/ /g')
		if [ "$a" = "$b" ]; then log "same  $label (${#a} bytes)"; else log "DIFF  $label"; fail=1; fi
	done
fi
[ $fail = 0 ] && log "passed" || log "FAILED"
exit $fail
