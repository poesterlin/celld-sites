#!/usr/bin/env bash
# End to end: names server + agent + Pebble (Let's Encrypt's test CA), all in
# throwaway containers sharing one network namespace. Pebble validates DNS-01
# against the names server, exactly as Let's Encrypt would against the public
# name servers, and the agent ends up with a wildcard certificate.
#
#   names/agent/test/e2e.sh
#
# Removes its containers and images when done.
set -euo pipefail
cd "$(dirname "$0")/../.."
ZONE=hamstr.test
RUN=names-e2e-$$
WORK=$(mktemp -d)
cleanup() {
	docker rm -f "$RUN-server" "$RUN-pebble" >/dev/null 2>&1 || true
	docker run --rm -v "$WORK:/w" alpine:3 rm -rf /w/data >/dev/null 2>&1 || true
	rm -rf "$WORK"
	docker image rm "$RUN-server" "$RUN-agent" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -q -t "$RUN-server" server >/dev/null
docker build -q -t "$RUN-agent" agent >/dev/null

# The server owns the network namespace. DNS on port 53, so lego and Pebble can
# find it through the zone's own NS record (ns1 → 127.0.0.1).
docker run -d --name "$RUN-server" \
	--sysctl net.ipv4.ip_unprivileged_port_start=0 \
	-e ZONE=$ZONE -e RECORDS="ns1 A 127.0.0.1" -e DNS_PORT=53 -e DNS_HOST=127.0.0.1 -e HTTP_HOST=127.0.0.1 \
	--read-only --cap-drop ALL --security-opt no-new-privileges \
	"$RUN-server" >/dev/null

docker run -d --name "$RUN-pebble" --network "container:$RUN-server" \
	-e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 \
	ghcr.io/letsencrypt/pebble:latest -dnsserver 127.0.0.1:53 >/dev/null

docker cp "$RUN-pebble:/test/certs/pebble.minica.pem" "$WORK/pebble-ca.pem"
chmod 644 "$WORK/pebble-ca.pem"
mkdir -m 777 "$WORK/data"

for _ in $(seq 30); do
	docker exec "$RUN-server" wget -q -O /dev/null http://127.0.0.1:8080/healthz 2>/dev/null && break
	sleep 0.5
done

# agent <command> [docker run options…]
agent() {
	local cmd=$1
	shift
	docker run "$@" --rm --network "container:$RUN-server" \
		-v "$WORK/data:/data" -v "$WORK/pebble-ca.pem:/pebble-ca.pem:ro" \
		-e NAME_SERVICE_URL=http://127.0.0.1:8080 -e ALLOW_INSECURE_SERVICE=1 \
		-e ADDRESS_IPV4=100.82.130.136 \
		-e ACME_SERVER=https://127.0.0.1:14000/dir -e LEGO_CA_CERTIFICATES=/pebble-ca.pem \
		-e DNS_RESOLVERS=127.0.0.1:53 \
		`# lego looks up ns1.hamstr.test with the system resolver, which does not know` \
		`# this fake zone; the check through DNS_RESOLVERS and Pebble's own still run.` \
		-e LEGO_DNS_PROPAGATION_DISABLE_ANS=true \
		--cap-drop ALL --security-opt no-new-privileges \
		"$RUN-agent" node agent.ts "$cmd"
}
inspect() {
	docker run --rm -v "$WORK/data:/data:ro" --entrypoint sh "$RUN-agent" -c "$1"
}

echo "== first run: register, set address, get a certificate"
agent once
HOST=$(inspect 'cat /data/tls/hostname')
echo "hostname: $HOST"

echo "== DNS for the install"
dig() { docker exec "$RUN-server" node -e "
	const r = new (require('node:dns').promises.Resolver)(); r.setServers(['127.0.0.1:53']);
	r.resolve('$1', '$2').then(v => console.log(JSON.stringify(v)), e => console.log(e.code));"; }
dig "$HOST" A
dig "grain-abc.$HOST" A
dig "_acme-challenge.$HOST" TXT # cleaned up after validation: ENODATA

echo "== certificate"
CERT=$(inspect 'cat /data/tls/cert.pem')
SANS=$(echo "$CERT" | openssl x509 -noout -ext subjectAltName | tail -1)
echo "SANs:$SANS"
echo "$SANS" | grep -q "DNS:$HOST" && echo "$SANS" | grep -q "DNS:\*.$HOST" || { echo "FAIL: wrong SANs"; exit 1; }
# The key matches the certificate, and is only readable by its owner.
[ "$(echo "$CERT" | openssl x509 -noout -pubkey | sha256sum)" = "$(inspect 'cat /data/tls/key.pem' | openssl pkey -pubout | sha256sum)" ] \
	|| { echo "FAIL: key does not match"; exit 1; }
inspect 'stat -c "%a %n" /data/tls/key.pem /data/names/state.json'

echo "== second run: nothing due, certificate unchanged"
BEFORE=$(inspect 'sha256sum /data/tls/cert.pem')
agent once
[ "$BEFORE" = "$(inspect 'sha256sum /data/tls/cert.pem')" ] && echo "unchanged" || { echo "FAIL: certificate changed"; exit 1; }

echo "== release, then the next run registers a new name and gets a new certificate"
agent release
dig "$HOST" A # ENOTFOUND
agent once
HOST2=$(inspect 'cat /data/tls/hostname')
[ "$HOST2" != "$HOST" ] || { echo "FAIL: same hostname after release"; exit 1; }
inspect 'cat /data/tls/cert.pem' | openssl x509 -noout -ext subjectAltName | tail -1

echo "== own-domain mode: no registration by the agent, lego talks to a DNS provider"
# Stand-in for a real provider: lego's httpreq provider against the names
# server, with a name registered by hand. The agent only sees DOMAIN and
# DNS_PROVIDER, as it would with e.g. DNS_PROVIDER=cloudflare.
REG=$(docker exec "$RUN-server" wget -q -O - --post-data= http://127.0.0.1:8080/v1/register)
OWN=$(echo "$REG" | sed 's/.*"hostname":"\([^"]*\)".*/\1/')
OWN_ID=$(echo "$REG" | sed 's/.*"id":"\([^"]*\)".*/\1/')
OWN_TOKEN=$(echo "$REG" | sed 's/.*"token":"\([^"]*\)".*/\1/')
docker run --rm -v "$WORK:/w" alpine:3 sh -c 'rm -rf /w/data/* && chmod 777 /w/data'
agent once -e HOSTNAME_MODE=domain -e DOMAIN="$OWN" -e DNS_PROVIDER=httpreq \
	-e HTTPREQ_ENDPOINT=http://127.0.0.1:8080/v1 -e HTTPREQ_USERNAME="$OWN_ID" -e HTTPREQ_PASSWORD="$OWN_TOKEN"
inspect 'cat /data/tls/cert.pem' | openssl x509 -noout -ext subjectAltName | tail -1 | grep -q "DNS:\*.$OWN" \
	|| { echo "FAIL: own-domain certificate"; exit 1; }
inspect 'test ! -e /data/names/state.json' && echo "own domain $OWN: certificate issued, nothing registered by the agent"

echo "PASS: $HOST, then $HOST2, own domain $OWN"
