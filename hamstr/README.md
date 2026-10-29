# Hamstr

**Your little apps, and everything you make with them, in your own burrow.**

Hamstr is a personal app platform in the spirit of [Sandstorm](https://sandstorm.io),
built on a celld-sites node. A hamster hoards *grains*; so does Hamstr.

- **Apps** come from the [Cubby](../cubby/README.md) store. Developers publish
  with the `cubby` CLI; everyone else only uses the web UI.
- **Grains**: every board, list or draw you make is its own grain. A grain is
  its own celld site at `grain-<id>.<domain>`, with its own Durable Objects
  (its data) and no network access unless the app declares egress and an admin
  allows it.
- **Sign-in is the platform's job.** Hamstr signs people in with OIDC (tsidp
  here) and tells each app who is visiting and what they may do. Apps contain
  no login code.
- **Sharing is by link.** An owner shares a grain with a role the app defines
  ("can view", "can pin", …). Links can be revoked, and revoking one cuts off
  everyone using it at once. Signed-in people keep shared grains under
  *Shared*; anyone else opens the link as a guest.

## How it works

```
 browser ──▶ Traefik ──▶ Hamstr ─────────────────────────────▶ celld router ──▶ grain isolate
             hamstr.<d>    shell UI, API, sign-in, share links    (site = grain-<id>.<d>)
             grain-*.<d>   grain proxy:                            only answers requests
                           · checks the grain session             that carry PROXY_TOKEN
                           · drops X-Hamstr-* from the browser
                           · adds X-Hamstr-User-Id, -Username,
                             -Permissions, -Role, -Grain-Id
```

Opening a grain: the shell (`/g/<id>`) asks the API for a one-time ticket
(60 s, single use, bound to that grain), loads
`https://grain-<id>.<d>/.hamstr/enter?ticket=…` in an iframe, and the grain
host turns the ticket into a grain session cookie. Every proxied request then
re-checks access: signing out, trashing the grain or revoking the share link
takes effect on the next request.

Installing an app downloads the release from the store, verifies its SHA-256
and contents (Cubby's bundle validator), uploads the code to celld once, and
boots it on a throwaway probe site (the deploy check) before anyone can use it.
A new grain only stages and activates that version: **~65 ms** on this VM. An
app update moves every grain to the new version; their data stays and the
app's migrations run on first use.

Measured locally against a real celld node (`npm run e2e`): install 230 ms,
new grain 65 ms, a proxied request ~1.5 ms more than going straight to celld.

## For app developers

Write a normal celld site ([docs/SITES.md](../docs/SITES.md)) and publish it
with `cubby publish`. Inside a grain, read who is visiting from request headers:

| Header | Value |
| --- | --- |
| `X-Hamstr-User-Id` | stable 32-hex id of a signed-in user; **absent for guests** |
| `X-Hamstr-Username` | display name, percent-encoded UTF-8 (`decodeURIComponent`) |
| `X-Hamstr-Permissions` | comma-separated permission ids from your `cubby.json` |
| `X-Hamstr-Role` | `owner`, the role id of the visitor's link, or `member` |
| `X-Hamstr-Grain-Id` | this grain's id |
| `X-Hamstr-Session-Id` | random per grain session |

The owner always holds every permission. Declare permissions and the roles an
owner can share in `cubby.json`:

```json
"permissions": [
	{ "id": "pin", "title": "Pin notes" },
	{ "id": "moderate", "title": "Moderate" }
],
"roles": [
	{ "id": "editor", "title": "Can pin", "permissions": ["pin"], "default": true },
	{ "id": "viewer", "title": "Can view", "permissions": [] }
]
```

An app without `roles` is shared all-or-nothing (role `member`); the share
dialog says so. Enforce permissions in your server code: Hamstr tells you what
the visitor may do, it does not know your routes.

Notes:

- These headers can be trusted *only* inside Hamstr grains: the router serves
  `grain-*` sites only to the proxy, and the proxy overwrites them.
- One grain = one site, so `env.OBJECTS.call("Board", "board", …)` names never
  collide between grains. Don't put several documents in one grain.
- A grain may set cookies for itself; cookies with a `Domain` attribute are
  dropped (they would reach other grains and other services).
- Don't rely on a `Referer` or on being top-level: grains run in the shell's
  iframe (`frame-ancestors` is the shell only) and also open in their own tab.

See `cubby/examples/pinboard` for a complete app that uses all of this.

## Running it

Hamstr is a compose service behind the `hamstr` profile, LAN-only like the
shelf (it holds `ADMIN_TOKEN`). Setup:

1. Register an OIDC client at the IdP with redirect URI
   `https://<HAMSTR_HOST>/auth/callback` (tsidp: its web UI, or its
   `/register` endpoint).
2. In `.env`: `COMPOSE_PROFILES=hamstr`, `HAMSTR_HOST`, `HAMSTR_GRAIN_DOMAIN`,
   `HAMSTR_GRAINS_RULE`, `HAMSTR_PROXY_TOKEN`, `HAMSTR_SECRET`, the three
   `HAMSTR_OIDC_*` values and `HAMSTR_ADMINS` (see `.env.example`).
3. Restart **celld** so the router learns the proxy token (`docker compose up -d
   celld`); until then grain sites answer nobody.
4. `docker compose up -d hamstr`.

`HAMSTR_ALLOWED_USERS` limits who can sign in at all (emails or usernames);
empty means anyone the IdP authenticates (for tsidp: anyone on the tailnet).
`HAMSTR_ADMINS` can install, update and remove apps; `*` makes everyone who
can sign in an admin.

Data: `hamstr-data` holds Hamstr's SQLite (users, sessions, grains, share
links). The grains' data is in the celld bucket like any site's. Back up both.

### Develop and test

```sh
npm test --prefix hamstr        # 27 tests: mock IdP, mock celld, real Cubby store
npm run e2e --prefix hamstr     # real celld dev node, real `cubby publish`, Pinboard
node hamstr/test/dev.mjs        # playground at http://hamstr.localhost:8795 (seeded)
```

## Security model

What Hamstr adds on top of [docs/SECURITY.md](../docs/SECURITY.md):

- **Identity cannot be forged by apps or other containers.** The router answers
  `grain-*` sites only with `x-celld-proxy-token` (it stores its SHA-256), strips
  it before site code runs, and an alias cannot bypass the check. Hamstr drops
  every `X-Hamstr-*` header the browser sends.
- **Grains cannot script each other.** Each grain is its own origin. Requests
  from another origin (including other grains on the same domain) are refused
  unless they are navigations; state-changing requests must be same-origin
  (`Sec-Fetch-Site`, falling back to `Origin`). Grain responses carry
  `frame-ancestors <shell>`, and the shell's iframe sandbox has no
  `allow-top-navigation` without a user click.
- **Sessions**: shell sessions are server-side (logout revokes), cookies are
  `__Host-` prefixed and HttpOnly. Grain sessions are tied to the shell session
  that opened them, so signing out ends them. Share links and tickets are
  stored only as SHA-256; a link is shown once.
- **Sign-in** uses the authorization code flow with PKCE, `state` and `nonce`;
  the ID token's signature (JWKS), issuer, audience and expiry are checked.
- **Cookie mode.** If the shell and the grains share a registrable domain
  (`hamstr.oesterlin.dev`, `grain-*.oesterlin.dev`) the grain cookie is
  `SameSite=Lax`. On different sites it is `SameSite=None; Partitioned` (CHIPS),
  which Chrome, Edge and Firefox support; Safari may not.

Limits worth knowing:

- **Same parent domain.** Grains at `grain-*.oesterlin.dev` share the parent
  domain with your other services. App JavaScript can still set
  `document.cookie = "…; domain=oesterlin.dev"` (the proxy only filters
  `Set-Cookie` headers). For apps you don't trust, use a separate grain domain.
- The runtime boundary is celld's (isolates in one process), not a VM: see the
  hostile-tenant checklist in docs/SECURITY.md.
- No Powerbox yet (grains requesting access to each other), no per-grain
  backup download, no WebSockets (celld has none).
