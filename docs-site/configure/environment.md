# Environment reference

The appliance is configured entirely by environment variables. In the Home Assistant add-on, the options become these
variables (see `appliance/ha-options.mjs`); the `env` option carries any extra `NAME=value` line.

Booleans are `true`/`false`. Values in a compose file are strings unless the file says otherwise.

## Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAMSTR_AUTH` | `required` | `none` turns on [home mode](/install/home-mode): no sign-in, plain HTTP, a port per grain. |
| `HAMSTR_GRAIN_PORTS` | `20000-20999` | Home mode: the host ports grains may use. |
| `HTTP_PORT` | `8000` | The container's plain-HTTP port. |
| `HTTPS_PORT` | `8443` | The container's HTTPS port. |
| `CELLD_LOG` | `warn` | celld's log level (`RUST_LOG`). `info` adds several routine lines a second. |
| `TZ` | UTC | Used for log timestamps and anything that schedules. |

Everything else inside the container listens on loopback in ports `47101`–`47181`, so host networking does not collide
with other services. See [Ports](/reference/ports).

## TLS and hostnames

| Variable | Default | Meaning |
| --- | --- | --- |
| `TLS_MODE` | `off` | `domain`, `names` or `off`. |
| `DOMAIN` | — | `domain` mode: the domain with a `*` record pointing here. |
| `DNS_PROVIDER` | — | `domain` mode: lego's provider id, e.g. `cloudflare`. |
| *provider variables* | — | The provider's own credentials (`lego dnshelp`). |
| `ACME_SERVER` | Let's Encrypt | Another ACME directory URL or lego shortcode. |
| `ACME_EMAIL` | none | Contact address for the ACME account. |
| `NAME_SERVICE_URL` | — | `names` mode: the names service, HTTPS only. |
| `ADDRESS_IPV4`, `ADDRESS_IPV6` | host's Tailscale address | `names` mode: what the name points at. |
| `HAMSTR_HOST` | the TLS hostname | The shell's hostname. Required with `TLS_MODE=off`. |
| `HAMSTR_GRAIN_DOMAIN` | the TLS hostname | Grains are `grain-<id>.<this>`. Required with `TLS_MODE=off`. |
| `HAMSTR_SCHEME` | `https` | What browsers use. `http` only for tests or plain proxies. |

## Sign-in

| Variable | Default | Meaning |
| --- | --- | --- |
| `OIDC_NAME` | — | The first provider's name; its id is the name lowercased. |
| `OIDC_ISSUER` | — | The issuer URL; must be HTTPS. |
| `OIDC_CLIENT_ID` | — | The client id registered at the provider. |
| `OIDC_CLIENT_SECRET` | — | The client secret. Required to seed the first provider. |
| `AUTH_URL` | — | Compose stack only: `https://<HAMSTR_HOST>/auth`, for site sign-in. |
| `AUTH_KEY` | generated | Compose stack only: HMAC key shared by the router and Hamstr. |

The `OIDC_*` variables seed the first provider on a fresh install and are ignored afterwards; manage providers in
**Settings → Sign-in**. See [Sign-in](/install/sign-in).

## Apps

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAMSTR_STORE` | — | The store apps come from. Empty means no store. |
| `HAMSTR_STORE_PUBLIC` | `HAMSTR_STORE` | The store's public URL, used for links. |
| `HAMSTR_PROXY_TOKEN` | generated | Appliance internal: proves a grain request came through Hamstr. Do not set by hand. |

## Limits

Per-site limits protect the node from one app taking everything. The defaults are fine for a small install.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SITE_TIMEOUT_SECS` | `30` | Wall-clock limit for a response and for each Durable Object call. Above it: 504. |
| `SITE_MAX_INFLIGHT` | `128` | Concurrent requests per site per router isolate. Above it: 503. |
| `SITE_MAX_OBJECTS` | `1000` | Durable Objects (databases) one site may create. |
| `SITE_MAX_SUBREQUESTS` | `1000` | Object calls plus egress fetches one request may make. |
| `CELLD_V8_HEAP_LIMIT_MB` | `256` | Per-isolate V8 heap. celld's own default is 128; an EmDash site needs the headroom. |
| `CELLD_LTX_RETENTION_SECS` | `3600` | How long write-log epochs are kept for a restore. |

## Storage and runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_FSYNC` | `true` | Flush each object to disk before acknowledging it. `false` is faster but a crash can lose the last writes. |
| `HAMSTR_DATA` | `/data` | Root of all state. Only useful for tests. |
| `PORT` | `3000` | Hamstr's own listener; internal. |
| `CELLD_MEM_LIMIT` | — | Compose stack only: the celld service's memory limit (the appliance has one limit for everything). |

## Setting them

In compose:

```yaml
environment:
  - TLS_MODE=domain
  - DOMAIN=example.com
```

In the Home Assistant add-on, either the matching option (`domain:`, `dns_provider:`, `oidc_issuer:`) or the free-form
`env` list:

```yaml
env:
  - CF_DNS_API_TOKEN=...
  - CELLD_LOG=info
```

## Secrets

- The platform's own secrets (S3 keys, admin token, the Hamstr secret, the auth key) are generated from
  `/dev/urandom` on first start into `/data/secrets.env`. Do not set them by hand.
- The OIDC client secret and DNS provider token are the only ones you supply. Keep them in `.env` (mode 600) rather
  than in `compose.yaml`.
- Changing `secrets.env` after the bucket exists makes the existing data unreadable. Back it up with the data.
