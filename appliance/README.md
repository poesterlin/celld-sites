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

The container starts as root only to take over `/data` if someone else owns
it (Home Assistant), then runs everything as uid 10001 (`run.sh`). With
`--user 10001` it skips that step.

### Home Assistant

`ha-addon/` and `repository.yaml` make this repo an add-on repository. The
add-on's options (`/data/options.json`) become the variables below
(`ha-options.mjs`); `env` takes extra `NAME=value` entries, such as the DNS
provider's token. Setup for users: [ha-addon/DOCS.md](../ha-addon/DOCS.md).
Release: tag `vX.Y.Z`, then set `version` in `ha-addon/config.yaml` to it.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAMSTR_AUTH` | `required` | `none`: home mode (below) |
| `HAMSTR_GRAIN_PORTS` | `20000-20999` | Home mode: the ports grains get |
| `HTTP_PORT`, `HTTPS_PORT` | `8000`, `8443` | The ports for browsers. Everything else is on loopback, ports 47101-47181, except the panel below |
| `CELLD_LOG` | `warn` | celld's log level (`RUST_LOG`); `info` adds its routine lines, several a second |
| `TLS_MODE` | `off` | `off`: HTTP on :8000, for a proxy in front that terminates TLS. `names`: a name from a Hamstr names service (`NAME_SERVICE_URL`). `domain`: your own domain at a DNS provider |
| `NAME_SERVICE_URL` | — | `names` mode: the names service ([names/README.md](../names/README.md)); a public one you trust, or one you host yourself |
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

### Home mode

`HAMSTR_AUTH=none` needs no settings at all:

- No sign-in: every visitor is the owner. Use it on a network you trust.
- Plain HTTP on `HTTP_PORT`, on any hostname (an IP, `homeassistant.local`).
  `TLS_MODE` is ignored.
- Each grain gets a port of its own (`HAMSTR_GRAIN_PORTS`), opened when the
  grain is first opened. A separate port is a separate origin, so grains stay
  isolated from each other and from the shell without hostnames. They are not
  isolated in cookies, which browsers share across ports; apps get their
  identity from Hamstr, not from cookies.
- Publish the grain ports, or use the host's network (`--network host`, which
  the Home Assistant add-on does).

### The Home Assistant panel

Port 8099 serves a small page for Home Assistant's sidebar (ingress) with links
to Hamstr on the box's own addresses (`panel.mjs`): `homeassistant.local` and
its IPs, or the TLS hostname. Only Home Assistant's ingress proxy
(`172.30.32.2`) and loopback get it. Hamstr itself cannot run inside the panel:
in home mode it is plain HTTP, which browsers refuse inside Home Assistant's
HTTPS page.

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
appliance/test/tls.sh           # HTTPS with the names agent and Pebble, configured like Home Assistant
```

Both run in CI (`.github/workflows/test.yml`, job `appliance`), and clean up
after themselves.
