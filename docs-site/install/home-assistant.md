# Home Assistant add-on

The add-on runs the [appliance](/install/) on Home Assistant OS and uses the host's network, so apps can get a port
each.

## Install

1. **Settings → Add-ons → Add-on Store**.
2. **⋮** (top right) → **Repositories**.
3. Add `https://github.com/poesterlin/celld-sites` and close.
4. Install **Hamstr**, then **Start**.
5. Click **Hamstr** in the sidebar, then **Open Hamstr**.

That is the whole setup in home mode: you are the owner, and there is no sign-in.

The panel is a small page with links to Hamstr on the box's own addresses (`homeassistant.local`, its IPs, or the TLS
hostname). Hamstr cannot open *inside* the panel: home mode is plain HTTP and Home Assistant's page is HTTPS, so the
panel opens a new tab instead.

## Home mode is the default

The add-on starts with `auth: none`:

- Anyone who can reach the box is the owner, including guests on your Wi-Fi.
- Plain HTTP. Browsers mark it "not secure".
- Passkeys, the clipboard, the camera and microphone, and installing apps to a home screen do not work.
- Each grain gets a port from `20000` up.

Read [Home mode](/install/home-mode) for the trade-offs before putting anything important in it.

## Options

| Option | Values | Meaning |
| --- | --- | --- |
| `store` | URL | The Hamstr Store apps come from. Without it there is nothing to install. |
| `auth` | `none`, `required` | `none` is home mode. `required` adds sign-in and needs `tls_mode`. |
| `tls_mode` | `off`, `names`, `domain` | `off` only makes sense with `auth: none`. |
| `domain` | hostname | `domain` mode: the domain with a `*.` record pointing at this box. |
| `dns_provider` | lego provider id | e.g. `cloudflare`, `hetzner`, `route53`. See `lego dnshelp`. |
| `env` | `NAME=value` list | Provider credentials, e.g. `CF_DNS_API_TOKEN=...`, and any appliance setting. |
| `name_service_url` | URL | `names` mode: an HTTPS names service. |
| `address` | IP | `names` mode: the address to publish. Found from Tailscale when empty. |
| `acme_email` | email | Contact address for the certificate account. |
| `hamstr_host`, `grain_domain` | hostnames | Override the hostname and the domain grains live under. |
| `oidc_name`, `oidc_issuer`, `oidc_client_id`, `oidc_client_secret` | | The first sign-in provider. |

## Sign-in and HTTPS

1. Set `auth: required`.
2. Set `tls_mode: domain`, `domain: example.com`, `dns_provider: cloudflare`, and add the token under `env`:

   ```yaml
   - CF_DNS_API_TOKEN=...
   ```

3. Point `example.com` **and** `*.example.com` at the Home Assistant box. The add-on uses the host network, so the
   addresses are the box's own.
4. Register an OIDC client at your provider. The redirect URI is:

   ```
   https://example.com/auth/callback/<provider name in lowercase>
   ```

   For `oidc_name: Tailscale` that is `/auth/callback/tailscale`.
5. Set `oidc_issuer`, `oidc_client_id` and `oidc_client_secret`, then restart the add-on.

HTTP stays on port 8000 and redirects to HTTPS on 8443. The first certificate is issued on first start and can take a
minute.

::: warning USB and network storage
The add-on's data lives in Home Assistant's add-on data folder and is included in Home Assistant backups. If you move
it to network storage, make sure the folder is writable by uid `10001`; the entrypoint fixes ownership only when it
starts as root.
:::

## Updating

Update the add-on like any other. The `version` in the add-on repository decides which image tag is used. Your data
survives the update; take a Home Assistant backup first anyway.

## More

- [HTTPS and domains](/install/https) — how DNS-01 works and what the records must be.
- [Sign-in](/install/sign-in) — OIDC, the first owner and invites.
- [Data and backups](/configure/data-and-backups) — what to copy.
