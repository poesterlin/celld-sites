#!/bin/sh
# Starts one celld node with the host-header router, and makes a fresh
# (or wiped) bucket usable without manual steps:
#   1. wait for the object store, create the bucket if it is missing
#   2. deploy the router app (cheap and idempotent, so on every start)
#   3. start the node
#   4. once it is healthy, deploy every bundled site in /app/sites
#      (/app/sites/<name>/, packed at image build time) whose site has no
#      active version yet. An existing site is left alone, so a restart never
#      undoes a deploy or rollback; update it with tools/deploy.sh.
set -eu

: "${CELLD_BUCKET:?}" "${S3_ENDPOINT:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
: "${ADMIN_TOKEN:?}" "${READ_TOKEN:?}" "${ADMIN_HOST:?}"
case "${SITE_TIMEOUT_SECS:-30}" in *[!0-9]* | "") echo "entrypoint: SITE_TIMEOUT_SECS must be a whole number" >&2; exit 1 ;; esac
for knob in SITE_MAX_INFLIGHT SITE_MAX_OBJECTS SITE_MAX_SUBREQUESTS; do
	eval "value=\${$knob:-}"
	case "$value" in "" | *[!0-9]*) echo "entrypoint: $knob must be a whole number" >&2; exit 1 ;; esac
done
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
# The router gets only SHA-256 hashes of the tokens: deployments are stored in
# the bucket, which the dashboard can read.
admin_hash=$(printf '%s' "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)
read_hash=$(printf '%s' "$READ_TOKEN" | sha256sum | cut -d' ' -f1)
sed -e "s/@ADMIN_TOKEN_SHA256@/$admin_hash/" -e "s/@READ_TOKEN_SHA256@/$read_hash/" -e "s/@ADMIN_HOST@/$ADMIN_HOST/" -e "s/@DEFAULT_SITE@//" -e "s#@OPERATOR_URL@#http://127.0.0.1:8081#" -e "s/@SITE_TIMEOUT_SECS@/${SITE_TIMEOUT_SECS:-30}/" \
	-e "s/@SITE_MAX_INFLIGHT@/${SITE_MAX_INFLIGHT:-128}/" -e "s/@SITE_MAX_OBJECTS@/${SITE_MAX_OBJECTS:-1000}/" -e "s/@SITE_MAX_SUBREQUESTS@/${SITE_MAX_SUBREQUESTS:-1000}/" \
	/app/router/wrangler.template.json > "$work/wrangler.json"
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
	for bundle in /app/sites/*/; do
		[ -d "$bundle" ] || continue
		host=$(basename "$bundle")
		[ "$host" = example ] && host="${EXAMPLE_HOST:-}"
		[ -n "$host" ] || continue
		for attempt in 1 2 3 4 5; do
			if out=$(tar -C "$bundle" -cf - . | /app/push.sh "$host" --if-new); then
				case "$out" in
				*'"skipped":true'*) log "$host already has an active version; bundled version not deployed" ;;
				*) log "deployed $host" ;;
				esac
				break
			fi
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
