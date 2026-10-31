#!/bin/bash
# Supervisor: S3 store, the celld node (which deploys the router), the names
# agent's first certificate, then Hamstr and Caddy. If any of them exits, the
# rest are stopped and the container exits, so the restart policy (Docker,
# Home Assistant's watchdog) restarts it as a whole.
set -euo pipefail
log() { echo "appliance: $*" >&2; }
. /app/ports.env
umask 077
echo $$ > /tmp/supervisor.pid
mkdir -p /data/s3 /data/celld /data/hamstr /data/caddy

# First start: generate every secret; later starts reuse them.
if [ ! -s /data/secrets.env ]; then
	rnd() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
	{
		echo "S3_ACCESS_KEY=$(rnd | cut -c1-20)"
		echo "S3_SECRET_KEY=$(rnd)"
		echo "ADMIN_TOKEN=$(rnd)"
		echo "READ_TOKEN=$(rnd)"
		echo "PROXY_TOKEN=$(rnd)"
		echo "HAMSTR_SECRET=$(rnd)"
		echo "AUTH_KEY=$(rnd)"
	} > /data/secrets.env.tmp
	mv /data/secrets.env.tmp /data/secrets.env
	log "generated secrets in /data/secrets.env"
fi
set -a; . /data/secrets.env; set +a

export ADMIN_HOST="${ADMIN_HOST:-admin.internal}"
TLS_MODE="${TLS_MODE:-off}"
# Home mode: no sign-in, plain HTTP, a port per grain. Hostnames are only used
# inside the container then; the browser reaches the shell on any name.
HAMSTR_AUTH="${HAMSTR_AUTH:-required}"
case "$HAMSTR_AUTH" in
required) ;;
none)
	if [ "$TLS_MODE" != off ]; then
		log "home mode is plain HTTP: ignoring TLS_MODE=$TLS_MODE (set HAMSTR_AUTH=required for sign-in and HTTPS)"
		TLS_MODE=off
	fi
	export HAMSTR_AUTH HAMSTR_HOST="${HAMSTR_HOST:-hamstr.internal}" HAMSTR_GRAIN_DOMAIN="${HAMSTR_GRAIN_DOMAIN:-grains.internal}"
	export HAMSTR_SCHEME=http HAMSTR_PUBLIC_PORT="$HTTP_PORT" HAMSTR_GRAIN_PORTS="${HAMSTR_GRAIN_PORTS:-20000-20999}"
	log "home mode: no sign-in. Anyone who can reach port $HTTP_PORT is the owner."
	;;
*) log "HAMSTR_AUTH must be required or none"; exit 1 ;;
esac
case "$TLS_MODE" in
off) ;;
names) export HOSTNAME_MODE=service ;;
domain) export HOSTNAME_MODE=domain ;;
*) log "TLS_MODE must be off, names or domain"; exit 1 ;;
esac

pids=()
stop() {
	log "stopping"
	# Front first, the store last: celld drains (about 15 s) and still writes.
	for name in caddy agent hamstr celld s3; do
		eval "pid=\${pid_$name:-}"
		[ -n "$pid" ] || continue
		t0=$SECONDS
		kill -TERM "$pid" 2>/dev/null || true
		while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
		log "$name stopped after $((SECONDS - t0)) s"
	done
}
trap 'stop; exit 0' TERM INT
# cert-changed.sh: a new hostname needs a fresh start (non-zero, so it restarts).
trap 'stop; exit 75' USR1

ROOT_ACCESS_KEY_ID=$S3_ACCESS_KEY ROOT_SECRET_ACCESS_KEY=$S3_SECRET_KEY VGW_FSYNC="${S3_FSYNC:-true}" \
	versitygw --quiet --port "127.0.0.1:$S3_PORT" posix /data/s3 &
pid_s3=$!; pids+=("$pid_s3")

# --- Certificate (TLS_MODE names / domain) ------------------------------------
# The names agent registers (names) or uses DOMAIN at DNS_PROVIDER (domain) and
# gets a wildcard certificate by DNS-01. It sees none of the secrets above.
agent() {
	env -u S3_ACCESS_KEY -u S3_SECRET_KEY -u ADMIN_TOKEN -u READ_TOKEN -u PROXY_TOKEN -u HAMSTR_SECRET -u AUTH_KEY \
		HAMSTR_DATA=/data LEGO_BIN=lego node /app/names/agent.ts "$@"
}
if [ "$TLS_MODE" != off ]; then
	# The address the name points at. Unset: this host's Tailscale address,
	# visible when the container shares the host network (Home Assistant add-on).
	if [ -z "${ADDRESS_IPV4:-}${ADDRESS_IPV6:-}" ] && [ "$TLS_MODE" = names ]; then
		ADDRESS_IPV4=$(node -e '
			const all = Object.values(require("os").networkInterfaces()).flat();
			const ts = all.find((a) => a.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));
			process.stdout.write(ts?.address ?? "");')
		[ -n "$ADDRESS_IPV4" ] || { log "TLS_MODE=names: no Tailscale address found; set ADDRESS_IPV4"; exit 1; }
		export ADDRESS_IPV4
		log "publishing the Tailscale address $ADDRESS_IPV4"
	fi
	# First start (or no certificate yet): get one before serving. Retries, so
	# a box that boots before its network comes up gets there eventually.
	delay=10
	until [ -s /data/tls/cert.pem ]; do
		agent once && break
		log "no certificate yet; retrying in $delay s"
		sleep "$delay" & wait $!
		delay=$(( delay < 300 ? delay * 2 : 300 ))
	done
	export TLS_HOSTNAME
	TLS_HOSTNAME=$(cat /data/tls/hostname)
	log "TLS for $TLS_HOSTNAME and *.$TLS_HOSTNAME"
	# By default the install's name is the shell, and grains live below it.
	export HAMSTR_HOST="${HAMSTR_HOST:-$TLS_HOSTNAME}"
	export HAMSTR_GRAIN_DOMAIN="${HAMSTR_GRAIN_DOMAIN:-$TLS_HOSTNAME}"
fi

: "${HAMSTR_HOST:?Set HAMSTR_HOST (the Hamstr hostname)}"
: "${HAMSTR_GRAIN_DOMAIN:?Set HAMSTR_GRAIN_DOMAIN (grains are grain-<id>.<this>)}"
export HAMSTR_SCHEME="${HAMSTR_SCHEME:-https}"
case "$HAMSTR_HOST" in "$ADMIN_HOST") log "HAMSTR_HOST must not be $ADMIN_HOST"; exit 1 ;; esac

# --- celld node -------------------------------------------------------------
CELLD_BUCKET=s3://celld S3_ENDPOINT="http://127.0.0.1:$S3_PORT" AWS_REGION=us-east-1 \
	CELLD_LISTEN="127.0.0.1:$CELLD_PORT" CELLD_INTERNAL_LISTEN="127.0.0.1:$CELLD_INTERNAL_PORT" \
	AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY AWS_SECRET_ACCESS_KEY=$S3_SECRET_KEY \
	AUTH_URL="${AUTH_URL:-$HAMSTR_SCHEME://$HAMSTR_HOST/auth}" \
	SITE_MAX_INFLIGHT="${SITE_MAX_INFLIGHT:-128}" SITE_MAX_OBJECTS="${SITE_MAX_OBJECTS:-1000}" \
	SITE_MAX_SUBREQUESTS="${SITE_MAX_SUBREQUESTS:-1000}" \
	CELLD_LTX_RETENTION_SECS="${CELLD_LTX_RETENTION_SECS:-3600}" \
	CELLD_V8_HEAP_LIMIT_MB="${CELLD_V8_HEAP_LIMIT_MB:-256}" \
	/app/entrypoint.sh &
pid_celld=$!; pids+=("$pid_celld")

until curl -fsS -o /dev/null "http://127.0.0.1:$CELLD_PORT/.well-known/celld/health" 2>/dev/null; do
	kill -0 "$pid_celld" 2>/dev/null || { log "celld exited during start"; stop; exit 1; }
	sleep 1
done
log "celld is up"

# --- Hamstr, Caddy, renewals ------------------------------------------------------
(cd /app && PORT=$HAMSTR_PORT HOST=127.0.0.1 HAMSTR_DATA=/data/hamstr \
	CELLD_ADMIN_API="http://127.0.0.1:$CELLD_PORT" \
	exec node hamstr/server.ts) &
pid_hamstr=$!; pids+=("$pid_hamstr")

# What the Caddyfiles read, also for cert-changed.sh's reload.
printf 'export ADMIN_HOST=%q HAMSTR_HOST=%q HAMSTR_GRAIN_DOMAIN=%q TLS_HOSTNAME=%q\n' \
	"$ADMIN_HOST" "$HAMSTR_HOST" "$HAMSTR_GRAIN_DOMAIN" "${TLS_HOSTNAME:-}" > /tmp/caddy.env
if [ "$HAMSTR_AUTH" = none ]; then
	caddy run --config /app/caddy/home.caddy --adapter caddyfile &
elif [ "$TLS_MODE" = off ]; then
	caddy run --config /app/caddy/http.caddy --adapter caddyfile &
else
	caddy run --config /app/caddy/tls.caddy --adapter caddyfile &
fi
pid_caddy=$!; pids+=("$pid_caddy")

if [ "$TLS_MODE" != off ]; then
	ON_CERT_CHANGE=/app/cert-changed.sh agent run &
	pid_agent=$!; pids+=("$pid_agent")
fi

# The first process to exit takes the container down.
set +e
wait -n "${pids[@]}"
status=$?
log "a process exited ($status); stopping the rest"
stop
exit $(( status == 0 ? 1 : status ))
