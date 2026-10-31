# Appliance

celld-sites and Hamstr in **one container**, for hosts that run single
containers: a Home Assistant add-on, a NAS app store, a Raspberry Pi, a small
VPS. Images for `linux/amd64` and `linux/arm64`
(`ghcr.io/poesterlin/celld-sites-appliance`).

```
            :8443 HTTPS / :8000 HTTP
                     │
                   Caddy ─── shell, grain-* ──▶ Hamstr :3000 ──┐
                     └────── any other name ──▶ celld  :8080 ◀─┘
                                                  │
                                       VersityGW :7070 (S3) ── /data/s3
names agent + lego ── DNS-01 ──▶ /data/tls (wildcard certificate)
```

Everything but Caddy listens on loopback. `start.sh` starts the processes in
order and stops them in reverse; if one exits, the container exits and the
restart policy (Docker, Home Assistant's watchdog) starts it again as a whole.
The compose stack in the project root is still the way to run this on a
homelab or a VPS with Traefik; the appliance is the same code, packaged for
places without one.

## Run

```sh
docker build -f appliance/Dockerfile -t celld-appliance .   # from the project root
docker run -d --name hamstr --init --restart unless-stopped --stop-timeout 60 \
  -p 443:8443 -p 80:8000 -v hamstr-data:/data \
  -e TLS_MODE=domain -e DOMAIN=hamstr.example.com \
  -e DNS_PROVIDER=cloudflare -e CF_DNS_API_TOKEN=... \
  -e OIDC_NAME=Tailscale -e OIDC_ISSUER=https://idp.tail1234.ts.net \
  -e OIDC_CLIENT_ID=... -e OIDC_CLIENT_SECRET=... \
  celld-appliance
```

Give `docker stop` 60 s (`--stop-timeout 60`): celld drains for about 15 s.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TLS_MODE` | `off` | `off`: HTTP on :8000, for a proxy in front that terminates TLS. `names`: a name from a Hamstr names service (`NAME_SERVICE_URL`). `domain`: your own domain at a DNS provider |
| `NAME_SERVICE_URL` | — | `names` mode: the names service ([names/README.md](../names/README.md); not deployed publicly yet, so this is your own for now) |
| `DOMAIN`, `DNS_PROVIDER` + the provider's variables | — | `domain` mode: lego's DNS-01 provider (`lego dnshelp`), and a `*.DOMAIN` record pointing at this host |
| `ADDRESS_IPV4`, `ADDRESS_IPV6` | the host's Tailscale address | `names` mode: what the name points at. Found automatically when the container shares the host network and the host runs Tailscale |
| `ACME_SERVER`, `ACME_EMAIL` | Let's Encrypt | Certificate authority |
| `HAMSTR_HOST`, `HAMSTR_GRAIN_DOMAIN` | the TLS hostname | The shell, and the domain grains live under (`grain-<id>.<domain>`). Required with `TLS_MODE=off` |
| `HAMSTR_SCHEME` | `https` | `http` only for tests |
| `OIDC_NAME`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | The first sign-in provider (afterwards: Settings → Sign-in). The issuer must be HTTPS. Redirect URI: `https://<HAMSTR_HOST>/auth/callback/<name in lowercase>` |
| `HAMSTR_STORE`, `HAMSTR_STORE_PUBLIC` | — | The Hamstr Store apps come from |
| `HAMSTR_NTFY_URL`, `SITE_*`, `CELLD_V8_HEAP_LIMIT_MB`, `CELLD_LTX_RETENTION_SECS`, `S3_FSYNC` | as in the compose stack | See `.env.example` in the project root |

With TLS, the install's name is the shell (`https://k3x9.hamstr.app`), grains
are `grain-<id>.k3x9.hamstr.app`, and any other name below it is a celld site.
A renewal reloads Caddy; a new name (after the names service released the old
one) restarts the container, since Hamstr was started for the old one.

### Tailscale

Tailscale's own certificates (`tailscale cert`) cover one machine name, not
the wildcard grains need, so TLS comes from DNS-01 instead and Tailscale only
carries the traffic: the name points at the Tailscale address, which only your
tailnet reaches. Nothing is published to the internet. tsidp gives "Sign in
with Tailscale" as the OIDC provider.

## Data

All of it is in `/data`: `s3/` (the bucket: every site's code and Durable
Object data), `celld/` (celld's local working copy), `hamstr/` (accounts,
grains), `tls/` and `names/` (certificate and registration), and
`secrets.env`, generated from `/dev/urandom` on first start. Back up the whole
volume; `secrets.env` belongs with the data, since the bucket only opens with
its keys.

Deploy a plain celld site the way `tools/deploy.sh` does, with the secrets
from the volume:

```sh
node tools/pack.ts sites/example /tmp/bundle
tar -C /tmp/bundle -cf - . | docker exec -i hamstr /app/with-env /app/push.sh blog.k3x9.hamstr.app
```

## Compared with the compose stack

- No dashboard: Hamstr is the UI.
- No separation between the services: they share one user and one memory
  limit. In the compose stack the dashboard only reads the bucket and each
  service has its own limits. Hamstr already holds `ADMIN_TOKEN` in both.
- If one process fails, everything restarts (about 20 s, most of it celld's
  drain).

## Tests

```sh
docker build -f appliance/Dockerfile -t celld-appliance .
node appliance/test/e2e.ts      # sign-in, app install, grain, site deploy, restarts (TLS_MODE=off)
appliance/test/tls.sh           # HTTPS with the names agent and Pebble, reload, new hostname
```

Both run in CI (`.github/workflows/test.yml`, job `appliance`), and clean up
after themselves.
