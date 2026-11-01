# Troubleshooting

Start with the log. Almost every question is answered by it.

```sh
docker compose ps
docker compose logs -f --tail=200
docker compose logs -f <container>       # the name from the generator, hamstr by default
```

To see celld's routine lines as well, set `CELLD_LOG=info`. It is chatty (several lines a second); turn it off again
afterwards.

## The container keeps restarting

The appliance runs a supervisor: if any of its processes exits, the whole container stops and Docker restarts it.
That is intended, but it hides which process failed.

Look for these lines near the end of the log:

```
appliance: a process exited (<status>); stopping the rest
appliance: <name> stopped after <n> s
```

| Last message | Likely cause |
| --- | --- |
| `HAMSTR_HOST must not be admin.internal` | `HAMSTR_HOST` is set to the internal admin name. Use your real hostname. |
| `TLS_MODE=names: no Tailscale address found` | Set `ADDRESS_IPV4`, or run the container with the host network and Tailscale on the host. |
| `no certificate yet; retrying` | DNS, provider credentials or the domain. It retries with backoff; see [HTTPS](#https-and-certificates). |
| `address already in use` | Another service owns port 8000, 8443 or a grain port. |
| Nothing, and the container exits | Out of memory. `docker inspect <container>` shows `.State.OOMKilled`; check the memory limit. |

Check the health status too:

```sh
docker inspect --format '{{.State.Health.Status}}' hamstr
```

`starting` for the first two minutes is normal. `unhealthy` after that means one of the loopback listeners is down;
the log says which.

## The page does not load

1. Is the container up? `docker compose ps`.
2. Does the shell answer inside the container's network?
   `docker compose exec <container> curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/`
3. Is the host port reachable? `curl -v http://127.0.0.1:8000/` from the host.
4. Behind a proxy? Check the proxy's log and its upstream. The shell hostname and the grain wildcard must both point
   at the container.

`404` from the shell for a random hostname is normal: Caddy answers only the hostnames it was configured for, and
celld answers 404 for names without a site.

## HTTPS and certificates

The appliance gets a wildcard certificate with DNS-01. In order:

```sh
# the records must resolve to the box, from somewhere else
dig +short example.com
dig +short '*.example.com'

# the container must resolve the same
docker compose exec hamstr getent hosts example.com
```

| Symptom | Check |
| --- | --- |
| `no certificate yet; retrying` | `DOMAIN` has no scheme/path; `DNS_PROVIDER` is a lego id; the token can read the zone and write TXT records. |
| `unauthorized` / `403` from the provider | Token scope. Cloudflare tokens need `Zone:Read` and `DNS:Edit` for that zone. |
| `NXDOMAIN` for the domain | The domain is not delegated to this provider, or the zone id is wrong. |
| The record appears then disappears | Some providers need a propagation wait; lego polls. Check the log for the TXT value. |
| Certificate issued, browser warns | DNS still points elsewhere. `dig` from the client, not the server. |
| Works on LAN, not from outside | The traffic path, not the certificate: a VPN-only address is not reachable from the internet, by design. |

The clock matters. ACME rejects a request when the system time is off by more than a few minutes:

```sh
docker compose exec hamstr date -u
```

## Sign-in problems

| Symptom | Check |
| --- | --- |
| `redirect_uri_mismatch` at the provider | The URI must be exactly `https://<HAMSTR_HOST>/auth/callback/<lowercase name>`. |
| "issuer must be HTTPS" | `OIDC_ISSUER` starts with `https://` and is a name with a valid certificate. |
| Login loop | Cookies dropped (proxy `Host` rewrite), clock skew, or the wrong `HAMSTR_SCHEME`. |
| 403 after sign-in | The person is not approved yet. The owner approves on **Settings → People**. |
| Nobody can sign in | The first person owns it; if that account is gone, restore a backup. Keep a second method configured. |

## Apps and grains

| Symptom | Check |
| --- | --- |
| Store page says no store | `HAMSTR_STORE` is empty or unreachable from the container. Test with `docker compose exec <container> curl -I <store-url>`. |
| Install fails during the deploy check | The bundle is broken or needs a capability the node refused. The log has the check's error. |
| Grain opens to an error | The grain hostname must reach the container: the grain wildcard is missing in DNS or the proxy. |
| App is slow on first open | It is starting; a large app takes a moment. Subsequent opens are warm until celld sheds it. |
| `503` from an app | The site is at `SITE_MAX_INFLIGHT`, or it is being restored/held by Hamstr. |
| `the isolate is over its V8 heap limit` | Raise `CELLD_V8_HEAP_LIMIT_MB` and give the container more memory. |
| App has no internet | It did not declare egress, or an admin has not allowed the hosts. |
| Data looks empty after an update | The app's migration failed; check the app's error page, then restore the grain's backup. |

## Disk full

The bucket grows with every database write and with every site version kept for rollback. Check the volume:

```sh
docker system df -v | grep -E 'hamstr|celld-sites'
du -sh /var/lib/docker/volumes/hamstr-data/_data/* 2>/dev/null
```

Do not delete files inside the bucket by hand. Use the platform's prune/rollback tools (compose stack) or take a fresh
backup and start a new install.

## Permissions

The appliance starts as root only to `chown` `/data` to uid `10001`, then drops privileges. If you run it with
`user: "10001:10001"` against a bind mount, the path must already be owned by `10001`:

```sh
sudo chown -R 10001:10001 /srv/hamstr
```

## Start over

This deletes everything. Back up first.

```sh
docker compose down
docker volume rm hamstr-data
docker compose up -d
```

With a bind mount, empty the directory instead. A fresh start generates new secrets and a new certificate.

## Ask for help

When reporting a problem, include:

- what you ran (the compose file with secrets removed);
- `docker compose logs` from the start of the failing run;
- `docker compose ps` and the health status;
- whether it is home mode, a domain, a names service or a proxy.

Redact tokens, client secrets and certificate keys.
