#!/usr/bin/env bash
# TLS end to end: the appliance with TLS_MODE=names against a names server and
# Pebble (Let's Encrypt's test CA), sharing one network namespace as in
# names/agent/test/e2e.sh. Checks the wildcard certificate, the routing behind
# it, a renewal reload, and that a new hostname restarts the container.
#
#   docker build -f appliance/Dockerfile -t celld-appliance . && appliance/test/tls.sh
#
# The appliance is configured the way Home Assistant does it (options.json).
# Removes its containers, volume and the names server image when done.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=${APPLIANCE_IMAGE:-celld-appliance}
ZONE=hamstr.test
RUN=appliance-tls-$$
WORK=$(mktemp -d)
cleanup() {
	[ -n "${KEEP:-}" ] && return
	docker rm -fv "$RUN" "$RUN-server" "$RUN-pebble" >/dev/null 2>&1 || true
	docker volume rm "$RUN-data" >/dev/null 2>&1 || true
	docker image rm "$RUN-server" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; docker logs --tail 40 "$RUN" 2>&1 | grep -vE 'celld::|INFO' || true; exit 1; }

docker build -q -t "$RUN-server" names/server >/dev/null
# celld uses 8080 inside the appliance, so the names API moves to 9080.
docker run -d --name "$RUN-server" \
	--sysctl net.ipv4.ip_unprivileged_port_start=0 \
	-e ZONE=$ZONE -e RECORDS="ns1 A 127.0.0.1" -e DNS_PORT=53 -e DNS_HOST=127.0.0.1 -e HTTP_HOST=127.0.0.1 -e HTTP_PORT=9080 \
	--read-only --cap-drop ALL --security-opt no-new-privileges \
	"$RUN-server" >/dev/null
docker run -d --name "$RUN-pebble" --network "container:$RUN-server" \
	-e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 \
	ghcr.io/letsencrypt/pebble:latest -dnsserver 127.0.0.1:53 >/dev/null
docker cp "$RUN-pebble:/test/certs/pebble.minica.pem" "$WORK/pebble-ca.pem"
chmod 644 "$WORK/pebble-ca.pem"
for _ in $(seq 30); do
	docker exec "$RUN-server" wget -q -O /dev/null http://127.0.0.1:9080/healthz 2>/dev/null && break
	sleep 0.5
done

# Configured like a Home Assistant add-on: settings in /data/options.json, /data
# owned by root, no environment variables.
docker volume create "$RUN-data" >/dev/null
docker run --rm -i -v "$RUN-data:/data" alpine:3 sh -c 'cat > /data/options.json && chown -R root:root /data && chmod 755 /data' <<JSON
{"tls_mode": "names", "name_service_url": "http://127.0.0.1:9080", "address": "100.64.0.10", "oidc_name": "Tailscale",
 "env": ["ALLOW_INSECURE_SERVICE=1", "ACME_SERVER=https://127.0.0.1:14000/dir", "LEGO_CA_CERTIFICATES=/pebble-ca.pem",
         "DNS_RESOLVERS=127.0.0.1:53", "LEGO_DNS_PROPAGATION_DISABLE_ANS=true"]}
JSON
docker run -d --name "$RUN" --init --restart on-failure --stop-timeout 60 --network "container:$RUN-server" \
	-v "$RUN-data:/data" -v "$WORK/pebble-ca.pem:/pebble-ca.pem:ro" \
	"$IMAGE" >/dev/null

healthy() {
	local t0=$SECONDS
	until [ "$(docker inspect -f '{{.State.Health.Status}}' "$RUN")" = healthy ]; do
		[ $((SECONDS - t0)) -lt 180 ] || fail "not healthy"
		sleep 1
	done
	echo $((SECONDS - t0))
}
echo "== fresh start: register, certificate, then serve ($(healthy) s to healthy)"
HOST=$(docker exec "$RUN" cat /data/tls/hostname)
echo "hostname: $HOST"
[ "$(docker exec "$RUN" sh -c 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "^celld " && stat -c %u $p; done' | sort -u)" = 10001 ] \
	|| fail "celld does not run as uid 10001"
echo "options.json read, root-owned /data taken over, services run as uid 10001"

# Pebble signs with a root it makes at start; trust exactly that one.
docker exec "$RUN-server" wget -q --no-check-certificate -O - https://127.0.0.1:15000/roots/0 > "$WORK/root.pem"
# curl from a throwaway container in the same namespace, verifying against Pebble's root.
c() { docker run --rm --network "container:$RUN-server" -v "$WORK/root.pem:/root.pem:ro" --entrypoint curl "$IMAGE" \
	-sS --cacert /root.pem -o /dev/null -w '%{http_code}' "$@"; }
resolve() { echo "--resolve $1:8443:127.0.0.1"; }

code=$(c $(resolve "$HOST") "https://$HOST:8443/api/health")
[ "$code" = 200 ] || fail "shell over HTTPS: $code"
echo "https://$HOST → Hamstr 200 (certificate verified)"
code=$(c $(resolve "grain-abcdefabcdef.$HOST") "https://grain-abcdefabcdef.$HOST:8443/")
# Hamstr answers 404 for a grain it does not know; its log shows it was Hamstr.
[ "$code" = 404 ] && docker logs "$RUN" 2>&1 | grep -q "GET grain-abcdefabcdef.$HOST/ 404" || fail "grain over HTTPS: $code"
echo "https://grain-….$HOST → Hamstr's grain proxy (wildcard verified)"
code=$(c $(resolve "blog.$HOST") "https://blog.$HOST:8443/")
[ "$code" = 404 ] || fail "other name: $code"
echo "https://blog.$HOST → celld router, 404 (no such site)"
loc=$(docker run --rm --network "container:$RUN-server" --entrypoint curl "$IMAGE" -sS -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: $HOST" http://127.0.0.1:8000/x)
case "$loc" in 30[18]\ https://$HOST/x) echo "http :8000 → $loc" ;; *) fail "redirect: $loc" ;; esac
code=$(c --resolve admin.internal:8443:127.0.0.1 https://admin.internal:8443/__admin/overview 2>/dev/null || true)
[ "$code" != 200 ] || fail "admin API through the front door"
echo "admin.internal through the front door: refused ($code)"

echo "== renewal: the agent's hook reloads Caddy"
docker exec -u 10001 "$RUN" /app/cert-changed.sh 2>/dev/null || fail "reload"
[ "$(c $(resolve "$HOST") "https://$HOST:8443/api/health")" = 200 ] || fail "after reload"
echo "reloaded, still serving"

echo "== new hostname: release the name; the next refresh registers a new one and restarts"
docker exec -u 10001 -e HAMSTR_DATA=/data -e NAME_SERVICE_URL=http://127.0.0.1:9080 -e ALLOW_INSECURE_SERVICE=1 "$RUN" node /app/names/agent.ts release
docker restart -t 60 "$RUN" >/dev/null
t0=$SECONDS
until [ "$(docker inspect -f '{{.RestartCount}}' "$RUN")" -ge 1 ]; do
	[ $((SECONDS - t0)) -lt 120 ] || fail "no restart after the hostname changed"
	sleep 1
done
echo "restarted by cert-changed.sh after $((SECONDS - t0)) s; healthy $(healthy) s later"
HOST2=$(docker exec "$RUN" cat /data/tls/hostname)
[ "$HOST2" != "$HOST" ] || fail "same hostname"
[ "$(c $(resolve "$HOST2") "https://$HOST2:8443/api/health")" = 200 ] || fail "new hostname over HTTPS"
echo "https://$HOST2 → 200"
echo "PASS: $HOST, then $HOST2"
