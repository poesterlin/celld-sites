# Sign-in

Hamstr is the only thing that signs people in. Apps never see a password, and they contain no login code.

Sign-in is OIDC. Any provider works: Tailscale's tsidp, Keycloak, Authentik, Authelia, a cloud identity provider, or a
small OIDC bridge in front of GitHub.

## Register the client

At your identity provider, create an OIDC client for Hamstr.

| Setting | Value |
| --- | --- |
| Redirect URI | `https://<HAMSTR_HOST>/auth/callback/<provider name in lowercase>` |
| Scopes | `openid`, `profile`, `email` |
| Client type | confidential (with a secret) or public |

The last part of the redirect URI comes from `OIDC_NAME`. `OIDC_NAME=Tailscale` gives
`/auth/callback/tailscale`; `OIDC_NAME=My IdP (work)` gives `/auth/callback/my-idp-work`. The generator shows the exact
URI for the name you type.

## Configure the install

```yaml
environment:
  - OIDC_NAME=Tailscale
  - OIDC_ISSUER=https://idp.example.ts.net
  - OIDC_CLIENT_ID=...
  # OIDC_CLIENT_SECRET comes from .env
```

- The issuer must be **HTTPS**. There is no exception for a LAN address; use a name with a certificate, or Tailscale.
- These settings seed the **first** provider on a fresh install. Afterwards, **Settings → Sign-in** manages providers
  and these variables are ignored.
- The provider is only seeded when the issuer, the client id **and** the client secret are all set. Use a confidential
  client for the first provider; a public client can be added later from Settings.

Restart the container after changing them.

## The first person owns it

Open Hamstr and sign in. The first person to do so becomes the owner.

Everyone else:

- comes with an **invite link**, or
- waits on the "people waiting" list until an admin approves them.

Once in, people can add a passkey or another sign-in method under **Your account**, and manage sessions there.

## Tailscale with tsidp

The compose stack has a `tsidp` profile: a Tailscale-backed OIDC provider, so people "Sign in with Tailscale" without a
separate identity server.

```sh
# in the compose stack, with a tsidp container and its auth key file
COMPOSE_PROFILES=hamstr,tsidp
TSIDP_HOSTNAME=idp
TSIDP_AUTHKEY_FILE=./secrets/ts_authkey
```

`tsidp` joins the tailnet under `TSIDP_HOSTNAME`, so there can only be one under that name. `TSIDP_FUNNEL=1` publishes
it on the internet through Tailscale Funnel; off by default.

The appliance does not bundle tsidp. Point it at any OIDC issuer, including a tsidp you run elsewhere.

## Sign-in for plain sites

Hamstr also signs people in for celld sites that declare it, not only for grains. A site with
`"auth": "required"` in `celld.json` sends visitors to Hamstr; **Settings → Sites** decides who may enter.

That path uses two shared settings in the compose stack:

| Variable | Meaning |
| --- | --- |
| `AUTH_URL` | `https://<HAMSTR_HOST>/auth` |
| `AUTH_KEY` | HMAC key shared by the router and Hamstr (`openssl rand -hex 32`) |

Restart celld after changing either. In the appliance this is wired internally; there is nothing to set.

## Later changes

- Add another provider in **Settings → Sign-in**. The `OIDC_*` variables are only read on a fresh install.
- Rename a provider and the redirect URI changes; register the new URI at the provider first.
- Removing the last sign-in method from the owner account locks everyone out. Keep a passkey or a second provider.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Provider says "redirect_uri_mismatch" | The registered URI does not match the one above, character for character. |
| "issuer must be HTTPS" in the log | `OIDC_ISSUER` uses `http://` or an IP address. |
| Sign-in loops back to the login page | Clock skew, a proxy that rewrites `Host`, or cookies dropped by the proxy. |
| Nobody can get in | You are not the first person, and no owner has approved you. The owner can invite from Settings → People. |
