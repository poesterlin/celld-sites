# Hamstr names

Gives every Hamstr install a hostname with a wildcard below it, and a real
certificate for both, with nothing to set up on the user's side: no domain, no
DNS server, no reverse proxy. The same idea as Sandstorm's sandcats.io and
Plex's plex.direct.

```
install k3x9 ──register / address / challenges──▶ names service ◀──DNS──── browsers, Let's Encrypt
     │                                              k3x9.hamstr.app         A    100.82.130.136
     └── lego ──── DNS-01 ─────▶ Let's Encrypt      *.k3x9.hamstr.app       A    100.82.130.136
         (key stays on the install)                 _acme-challenge.k3x9…   TXT  (during issuance)
```

The service only answers DNS and accepts challenge values. It never sees
certificates, keys or any traffic: names point at private and Tailscale
addresses, which only the install's own devices can reach.

| Path | What |
| --- | --- |
| `server/` | The service: HTTP API and the zone's authoritative DNS server (UDP and TCP), state in one SQLite file. Node, no dependencies. |
| `agent/` | The install side: registers, keeps the address current, gets and renews the certificate with [lego](https://go-acme.github.io/lego/), writes it to `$DATA/tls/`. |

## Modes (agent)

| `HOSTNAME_MODE` | For | Needs | Who sees anything |
| --- | --- | --- | --- |
| `service` (default) | everyone | `NAME_SERVICE_URL` | the service operator: the install's private address and when it renews |
| `service` with your own `NAME_SERVICE_URL` | a family, club or company running several installs | a domain and a server for `server/` | only you |
| `domain` | one user who wants no third party | `DOMAIN`, `DNS_PROVIDER` plus that provider's variables (`lego dnshelp`), and a `*.DOMAIN` record pointing at the install | only your DNS provider |

What is public in every mode: certificates from a public CA land in the
Certificate Transparency logs (the wildcard keeps grain names out, the hostname
is in), and public DNS shows the install's private address. To keep the address
out of public DNS in `domain` mode, serve the A records inside the tailnet only
(Tailscale split DNS) and leave only the challenge TXT records public.

Agent variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HAMSTR_DATA` | `/data` | State (`names/`) and output (`tls/cert.pem`, `tls/key.pem`, `tls/hostname`) |
| `NAME_SERVICE_URL` | — | The names service, `https://` only (`ALLOW_INSECURE_SERVICE=1` for tests) |
| `ADDRESS_IPV4`, `ADDRESS_IPV6` | `tailscale ip` | The address to publish |
| `ACME_SERVER` | Let's Encrypt | Any ACME directory URL or lego shortcode |
| `ACME_EMAIL` | none | Contact for the ACME account |
| `REFRESH_HOURS` | `6` | Address refresh and renewal check; also the service's "still alive" signal |
| `ON_CERT_CHANGE` | none | Shell command run after a new certificate is written (reload the TLS server) |

`node agent.ts run` refreshes forever, `once` refreshes once, `release` gives
the name back.

## Server API

All routes but `register` take the install's token as `Authorization: Bearer
<token>`, or as Basic auth with the id as user (what lego's `httpreq` provider
sends).

```
POST   /v1/register                 → 201 { id, hostname, token }   rate-limited per client address
GET    /v1/install                  → { id, hostname, ipv4, ipv6, lastSeen }
PUT    /v1/address  { ipv4, ipv6 }  → the install; private / Tailscale addresses only
POST   /v1/present  { fqdn, value } → 200   only _acme-challenge.<id>.<zone>, at most 4 values, 1 h lifetime
POST   /v1/cleanup  { fqdn, value } → 200
DELETE /v1/install                  → 204
GET    /healthz                     → 200
```

Tokens are stored as SHA-256 hashes. Installs that have not called the API for
`EXPIRE_DAYS` (90) are released. Configuration: `server/.env.example`.

## Tests

```sh
npm test --prefix names/server   # API, DNS answers over UDP and TCP, limits
names/agent/test/e2e.sh          # server + agent + Pebble (Let's Encrypt's test CA), both modes
```

The end-to-end test issues real wildcard certificates from Pebble, validated
through the names server's DNS, and cleans up its containers afterwards.

## Before running it for other people

Not deployed yet; this is the checklist.

1. **A domain**, separate from anything else you run (installs get names under
   it), with NS records delegating it to the server(s) in `NAMESERVERS`, and
   glue records at the registrar if they sit inside the zone.
2. **A public server for DNS**: port 53 UDP and TCP must be reachable from the
   internet (a small VPS; `server/compose.yaml`). Two name servers in different
   places are better than one. The API can sit behind a Cloudflare tunnel or a
   reverse proxy with TLS; set `TRUST_PROXY=true` then.
3. **The Public Suffix List.** Submit the zone to
   [publicsuffix.org](https://github.com/publicsuffix/list) before real users
   arrive; it takes weeks. Without it, Let's Encrypt counts every install's
   certificate against one registered domain (50 new certificates a week), and
   one install could set cookies on the parent domain that every other install
   receives.
4. **Abuse contact** in `HOSTMASTER`, and a short policy: names point at
   private addresses only, so the zone cannot host public content.
