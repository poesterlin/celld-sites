#!/bin/sh
# Starts one celld node with the host-header router, and makes a fresh
# (or wiped) bucket usable without manual steps:
#   1. wait for the object store, create the bucket if it is missing
#   2. deploy the router app (cheap and idempotent, so on every start)
#   3. start the node
#   4. once it is healthy, deploy every bundled site in /app/sites
#      (/app/sites/<hostname>.json, packed at image build time)
set -eu

: "${CELLD_BUCKET:?}" "${S3_ENDPOINT:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
: "${ADMIN_TOKEN:?}" "${READ_TOKEN:?}" "${ADMIN_HOST:?}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
STORE="--bucket $CELLD_BUCKET --endpoint $S3_ENDPOINT --region $AWS_REGION"
log() { echo "entrypoint: $*" >&2; }

for token in "$ADMIN_TOKEN" "$READ_TOKEN"; do
	case "$token" in *[!A-Za-z0-9_-]*) log "ADMIN_TOKEN and READ_TOKEN may only contain A-Z a-z 0-9 _ -"; exit 1 ;; esac
done

umask 077
s3auth=$(mktemp)
printf 'user = "%s:%s"\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > "$s3auth"
# Body-less S3 calls only: curl 7.88 does not add x-amz-content-sha256, which S3
# servers require, so send the hash of the empty body.
EMPTY_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
s3() { curl -sS -K "$s3auth" --aws-sigv4 "aws:amz:$AWS_REGION:s3" -H "x-amz-content-sha256: $EMPTY_SHA256" "$@"; }

# 1. Object store and bucket ------------------------------------------------
bucket=${CELLD_BUCKET#s3://}
bucket=${bucket%%/*}
until s3 -o /dev/null "$S3_ENDPOINT/" 2>/dev/null; do log "waiting for $S3_ENDPOINT"; sleep 1; done
if [ "$(s3 -o /dev/null -w '%{http_code}' -I "$S3_ENDPOINT/$bucket")" != 200 ]; then
	log "creating bucket $bucket"
	s3 --fail -X PUT --data-binary '' -o /dev/null "$S3_ENDPOINT/$bucket"
fi
rm -f "$s3auth"

# 2. Router app ---------------------------------------------------------------
work=$(mktemp -d)
cp /app/router/index.js "$work/"
sed -e "s/@ADMIN_TOKEN@/$ADMIN_TOKEN/" -e "s/@READ_TOKEN@/$READ_TOKEN/" -e "s/@ADMIN_HOST@/$ADMIN_HOST/" /app/router/wrangler.template.json > "$work/wrangler.json"
log "deploying the router"
# shellcheck disable=SC2086
celld deploy "$work" $STORE
rm -rf "$work"

# 3. Node ---------------------------------------------------------------------
# The public listener serves the sites; the internal (operator) listener has an
# unauthenticated API, so it stays on loopback inside this container.
# shellcheck disable=SC2086
celld $STORE --listen 0.0.0.0:8080 --internal-listen 127.0.0.1:8081 &
node=$!
trap 'kill -TERM "$node" 2>/dev/null' TERM INT

# 4. Bundled sites --------------------------------------------------------------
(
	until curl -sf -o /dev/null http://127.0.0.1:8080/.well-known/celld/health; do
		kill -0 "$node" 2>/dev/null || exit 0
		sleep 1
	done
	for payload in /app/sites/*.json; do
		[ -e "$payload" ] || continue
		host=$(basename "$payload" .json)
		[ "$host" = example ] && host="${EXAMPLE_HOST:?}"
		for attempt in 1 2 3 4 5; do
			if /app/push.sh "$host" < "$payload" >/dev/null; then log "deployed $host"; break; fi
			log "deploying $host failed (attempt $attempt), retrying"; sleep 2
		done
	done
) &

# Wait for the node. `wait` returns early when the trap forwards a signal, so
# keep waiting until the node has actually exited and report its status.
status=0
while kill -0 "$node" 2>/dev/null; do
	status=0
	wait "$node" || status=$?
done
exit "$status"
