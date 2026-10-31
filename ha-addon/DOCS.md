# Hamstr

Install little web apps in one click.
Your data stays on this Home Assistant box.

> Work in progress. Expect changes.

## Before you start

You need two things:

1. **A domain** with a DNS provider that has an API, for example Cloudflare.
2. **A sign-in provider** (OIDC) with an HTTPS address, for example
   [tsidp](https://github.com/tailscale/tsidp) for "Sign in with Tailscale".

## Set up

1. Point `*.your-domain` and `your-domain` at this box.
   Use its Tailscale address to keep it private to your tailnet.
2. Fill in the options:
   - `tls_mode`: `domain`
   - `domain`: for example `hamstr.example.com`
   - `dns_provider`: for example `cloudflare` (see `lego dnshelp`)
   - `env`: the provider's token, for example `CF_DNS_API_TOKEN=...`
   - `oidc_*`: your sign-in provider
3. In the sign-in provider, allow this redirect address:
   `https://<domain>/auth/callback/<oidc_name in lowercase>`
4. Start the add-on. The first start gets a certificate, which takes a minute.
5. Open `https://<domain>`. The first person to sign in becomes the owner.

## Options

| Option | What it does |
| --- | --- |
| `tls_mode` | `domain`: your own domain. `names`: a Hamstr names service. `off`: plain HTTP on port 80 |
| `name_service_url`, `address` | For `names` mode: the service, and the address the name points at |
| `hamstr_host`, `grain_domain` | Only for `off`. Otherwise they come from the domain |
| `store` | The Hamstr Store to install apps from |
| `ntfy_url` | Notify an ntfy topic when someone waits for approval |

## Data

Everything is in the add-on's data folder, including generated secrets.
Home Assistant backups include it.
