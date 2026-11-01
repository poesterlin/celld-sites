# HTTPS and domains

Hamstr needs a wildcard certificate, because every grain is its own origin at `grain-<id>.<domain>`.

That rules out HTTP-01: Let's Encrypt cannot issue a wildcard that way. The appliance gets certificates with
**DNS-01** — it proves control of the domain by writing a TXT record through your DNS provider's API.

## The three TLS modes

`TLS_MODE` decides where the certificate comes from. The container always serves HTTPS on **8443** and HTTP on
**8000**; HTTP redirects to HTTPS when a certificate exists.

| `TLS_MODE` | Certificate | Needs | Use when |
| --- | --- | --- | --- |
| `domain` | wildcard for your domain | a domain, a DNS provider API token, `*` DNS record | you own a domain and its DNS |
| `names` | wildcard under a name someone gives you | a names service URL | you do not want to manage a domain |
| `off` | none (your proxy terminates TLS) | a proxy that does HTTPS | something in front already does TLS |

## Mode: domain

Set:

```yaml
environment:
  - TLS_MODE=domain
  - DOMAIN=example.com
  - DNS_PROVIDER=cloudflare
  - ACME_EMAIL=you@example.com        # optional
  # the provider's token comes from .env (see the generator)
```

The install's hostname becomes `example.com`, and grains live under it. Override them with `HAMSTR_HOST` and
`HAMSTR_GRAIN_DOMAIN` if you want the shell somewhere else — as long as both names resolve to this box.

### DNS records

Create both records, pointing at the box:

| Name | Type | Value |
| --- | --- | --- |
| `example.com` | `A` / `AAAA` | the box's address |
| `*.example.com` | `A` / `AAAA` | the same address |

A wildcard `CNAME` also works if it resolves to a name with the right `A`/`AAAA`. Some providers need the wildcard
created separately from the apex; check yours.

If the box is only reachable over Tailscale, point both records at its `100.x` address. The certificate still comes
from a public CA, but DNS gives the address only to people who can resolve it.

### The provider token

The token must be allowed to **read the zone and create/delete TXT records**. Nothing else.

| Provider | `DNS_PROVIDER` | Variables |
| --- | --- | --- |
| Cloudflare | `cloudflare` | `CF_DNS_API_TOKEN` |
| Hetzner | `hetzner` | `HETZNER_API_TOKEN` |
| DigitalOcean | `digitalocean` | `DO_AUTH_TOKEN` |
| Amazon Route 53 | `route53` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Namecheap | `namecheap` | `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY` |
| Gandi | `gandi` | `GANDI_API_KEY` |
| Porkbun | `porkbun` | `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` |
| Duck DNS | `duckdns` | `DUCKDNS_TOKEN` |
| OVH | `ovh` | `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY` |
| Netcup | `netcup` | `NETCUP_CUSTOMER_NUMBER`, `NETCUP_API_KEY`, `NETCUP_API_PASSWORD` |
| IONOS | `ionos` | `IONOS_API_KEY` |
| deSEC | `desec` | `DESEC_TOKEN` |
| GoDaddy | `godaddy` | `GODADDY_API_KEY`, `GODADDY_API_SECRET` |
| INWX | `inwx` | `INWX_USERNAME`, `INWX_PASSWORD` |
| Linode | `linode` | `LINODE_TOKEN` |
| Vultr | `vultr` | `VULTR_API_KEY` |
| Scaleway | `scaleway` | `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_PROJECT_ID` |

The appliance bundles [lego](https://go-acme.github.io/lego/) v5.6.0. Its `dnshelp` command is authoritative for a
provider's variables and any extra requirements (some need CNAME delegation):

```sh
docker run --rm goacme/lego:v5.6.0 dnshelp
```

Any provider lego supports works; the table is just the common ones.

### Ports

Publish `443:8443` and `80:8000`. Port 80 is only used to redirect to HTTPS; certificate issuance itself goes through
the DNS API, so a box without inbound 80 can still get certificates if you skip the redirect.

## Mode: names

A names service gives the install a hostname with a wildcard below it and issues the certificate through the same
DNS-01 flow. The install registers itself; you do not touch DNS for the install.

```yaml
environment:
  - TLS_MODE=names
  - NAME_SERVICE_URL=https://names.example.com
  - ADDRESS_IPV4=100.64.0.10      # this computer's Tailscale or LAN address
  # - ADDRESS_IPV6=fd7a:115c:a1e0::10
```

`NAME_SERVICE_URL` must be HTTPS (except in tests). The install publishes an address of its own; the service only
accepts **private** addresses (LAN, Tailscale/CGNAT, ULA). It never proxies traffic.

### First start

The service assigns a name such as `k3x9.hamstr.example.com`. The install then gets a wildcard certificate for it and
Caddy starts serving it. Read the assigned name with:

```sh
docker compose exec <container> cat /data/tls/hostname
```

Register the OIDC redirect URI at your provider *after* that first start — the address did not exist before:

```
https://<assigned-name>/auth/callback/<provider id>
```

If you set `OIDC_*` in the compose file, the provider is already seeded, so adding the redirect at the IdP is enough.
If you did not, add the values and restart.

Set `ADDRESS_IPV4` (or `ADDRESS_IPV6`) unless the container uses the host network and can see Tailscale itself. A
normal Docker network hides the host's interface, and the install cannot guess the address.

### Hosting a service for other people

The service is [names/](https://github.com/poesterlin/celld-sites/tree/main/names) in this repository. Anyone can run
it; it is not tied to a central instance. Give people the URL and they use it as `NAME_SERVICE_URL`.

To run one:

1. **A zone.** Choose a domain (for example `hamstr.example.com`), delegate it to the server with NS records, and
   open **port 53 UDP and TCP** to it. A small VPS is enough.
2. **The API.** Put the HTTP API behind HTTPS (Caddy, Traefik or a tunnel). Set `TRUST_PROXY=true` behind a proxy so
   registration limits see the client's address.
3. **Configuration.** Set `ZONE` and `NAMESERVERS`; see
   [names/server/.env.example](https://github.com/poesterlin/celld-sites/blob/main/names/server/.env.example) and the
   [names README](https://github.com/poesterlin/celld-sites/tree/main/names).
4. **The Public Suffix List.** Submit the zone before real users arrive. Without it, every install shares one
   registered domain for cookies and Let's Encrypt's certificate limits, and one install could set a cookie for
   another.
5. **Abuse and expiry.** Set a `HOSTMASTER` contact. Installs that stop refreshing for `EXPIRE_DAYS` (90) are
   released, and names are reused.

A public names service does **not** make installs reachable from the internet: every name points at a private
address. Visitors still need the LAN or Tailscale. Public DNS shows the private address; certificate transparency
logs show the install's hostname.

## Mode: off (a proxy does TLS)

```yaml
environment:
  - TLS_MODE=off
  - HAMSTR_HOST=hamstr.example.com
  - HAMSTR_GRAIN_DOMAIN=example.com
  - HAMSTR_SCHEME=https
```

Nothing in the container does TLS. The proxy must route the shell hostname and `grain-*.<grain domain>` here. See
[Behind a proxy](/install/proxy).

## Renewal and changes

- Certificates renew automatically; a renewal reloads Caddy.
- Changing the hostname means a new certificate and a restart of the container (Hamstr was started for the old name).
- `ACME_SERVER` points at another ACME directory (a test CA or a private one). `ACME_EMAIL` sets the account contact.
- Certificate Transparency logs will contain the install's hostname. The wildcard keeps individual grain names out.

## Troubleshooting

If no certificate arrives:

1. Read the log: `docker compose logs -f <container>`.
2. Check the DNS records resolve to the box from somewhere else.
3. Check the provider token can read the zone and write TXT records.
4. Check `DOMAIN` has no scheme or path.
5. Make sure the clock is right; ACME rejects a skewed clock.

[Full troubleshooting](/help/troubleshooting#https-and-certificates).
