# Hamstr

**Your little apps, and everything you make with them, in your own burrow.**

Hamstr is a personal app platform in the spirit of [Sandstorm](https://sandstorm.io),
built on a celld-sites node. A hamster hoards *grains*; so does Hamstr.

- **Apps** come from the [Hamstr Store](../store/README.md). Developers publish
  with the `hamstr` CLI; everyone else only uses the web UI. *Home* is a
  launcher: every installed app is an icon there. An admin's *Get* in the store
  puts an app on everyone's Home at once; only an app that wants internet
  access asks first.
- **Grains**: every board, list or draw you make is its own grain. A grain is
  its own celld site at `grain-<id>.<domain>`, with its own Durable Objects
  (its data) and no network access unless the app declares egress and an admin
  allows it. Tapping an app shows the grains you made with it and a *New* tile
  (a new one is called "Untitled …" until you rename it in the title bar). An
  app that declares `"instances": "single"` has one grain per person instead:
  its icon opens it directly, and the first open creates it.
- **Sign-in is the platform's job.** Hamstr signs people in with OIDC (tsidp
  here) and tells each app who is visiting and what they may do. Apps contain
  no login code.
- **Private by default.** A grain belongs to the person who made it; nobody
  else on the Hamstr can list, open or download it. (Share links existed
  once and were removed; their old tables stay in the database, unused.)

## How it works

```
 browser ──▶ Traefik ──▶ Hamstr ─────────────────────────────▶ celld router ──▶ grain isolate
             hamstr.<d>    shell UI, API, sign-in                 (site = grain-<id>.<d>)
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
re-checks access: signing out or trashing the grain
takes effect on the next request.

Installing an app downloads the release from the store, verifies its SHA-256
and contents (the shared bundle validator in `packages/app-format`), uploads the code to celld once, and
boots it on a throwaway probe site (the deploy check) before anyone can use it.
A new grain only stages and activates that version: **~65 ms** on this VM. An
app update moves every grain to the new version; their data stays and the
app's migrations run on first use.

Measured locally against a real celld node (`npm run e2e`): install 230 ms,
new grain 65 ms, a proxied request ~1.5 ms more than going straight to celld.

## For app developers

Write a normal celld site ([docs/SITES.md](../docs/SITES.md)) and publish it
with `hamstr publish`. Inside a grain, read who is visiting from request headers:

| Header | Value |
| --- | --- |
| `X-Hamstr-User-Id` | stable 32-hex id of the signed-in owner |
| `X-Hamstr-Username` | display name, percent-encoded UTF-8 (`decodeURIComponent`) |
| `X-Hamstr-Permissions` | comma-separated permission ids from your `hamstr.json` |
| `X-Hamstr-Role` | always `owner` |
| `X-Hamstr-Grain-Id` | this grain's id |
| `X-Hamstr-Session-Id` | random per grain session |

The owner holds every permission the app declares in `hamstr.json`
(`"permissions": [{ "id": "pin", "title": "Pin notes" }]`), so an app written
for several roles still works. The retired `roles` field is still accepted in
manifests and ignored.

Add `"instances": "single"` for an app people only need one of (a family
board, a settings page): Home opens it straight away. The default, `"many"`,
suits documents. In the API, `POST /api/apps/<slug>/open` finds or creates
the visitor's one grain of a single-instance app.

**Download data.** Add `"export": "/export"` (any GET path in your app) and
owners get *Download data* on the item's menu and title bar. Hamstr calls that
path through celld as the owner (`X-Hamstr-Role: owner`, plus
`X-Hamstr-Export: 1`) and returns your answer as an attachment named after the
item and the date. Answer 200 with any format (JSON, CSV, a zip); the
extension comes from your `Content-Disposition` filename or the content type.
Without `export`, owners still have backups (below), just not a readable
format.

**Backups, for every app.** Every item has *Download backup* and *Restore from
backup…* on its menus, and an app's page has *Import a backup…* (a new item
from a backup). A backup (`.hamstr-backup`) is a header line (app, app
version, item name, time) followed by celld's dump of the item's objects:
every table, row and stored key, no app code involved (see "Back up and
restore" in the [celld-sites README](../README.md)). Restoring replaces the
item's data: Hamstr first takes a safety copy, holds the item's traffic (503)
while it runs, and puts the safety copy back if the restore fails half-way.
A backup only goes into the same app, and not into an older version of it than
the one that made it (update the app first); an older backup is migrated by the
app's own code when the item next starts. API: `GET /api/grains/<id>/backup`,
`PUT /api/grains/<id>/backup` (the file as `application/octet-stream`),
`POST /api/apps/<slug>/import`; owner only, up to 1 GiB.

Notes:

- These headers can be trusted *only* inside Hamstr grains: the router serves
  `grain-*` sites only to the proxy, and the proxy overwrites them.
- One grain = one site, so `env.OBJECTS.call("Board", "board", …)` names never
  collide between grains. Don't put several documents in one grain.
- A grain may set cookies for itself; cookies with a `Domain` attribute are
  dropped (they would reach other grains and other services).
- Don't rely on a `Referer` or on being top-level: grains run in the shell's
  iframe (`frame-ancestors` is the shell only) and also open in their own tab.

See `store/examples/pinboard` for a complete app that uses all of this.

## Running it

Hamstr is a compose service behind the `hamstr` profile, LAN-only (it holds
`ADMIN_TOKEN`). Setup:

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
`HAMSTR_ADMINS` can install, update and uninstall apps; `*` makes everyone who
can sign in an admin.

**Uninstalling** (an app's ⋯ menu, its right-click menu, the store) removes the
app for everyone *and deletes every item made with it*, other people's and the
trash included; the dialog says how many and from whom first. In the API,
`GET /api/apps/<slug>` returns that `usage`, and `DELETE /api/apps/<slug>`
answers 409 while items exist unless called with `?items=delete`. If any
item's site cannot be deleted, the app stays installed.

Data: `hamstr-data` holds Hamstr's SQLite (users, sessions, grains). The grains' data is in the celld bucket like any site's. Back up both.

### Develop and test

The UI and the JSON API are a SvelteKit app in `hamstr/src` (SSR, Svelte 5
runes). `hamstr/server.mjs` is the HTTP entrypoint: it routes on the Host
header, proxies the grain hosts, and hands everything else to adapter-node. The
plain-Node modules in `hamstr/lib` hold the platform core, the celld and OIDC
clients and the proxy, so the tests drive them without a browser.

```sh
npm test --prefix hamstr            # 34 tests: mock IdP, mock celld, real Hamstr Store
npm run e2e --prefix hamstr         # real celld dev node, real `hamstr publish`, Pinboard
npm run playground --prefix hamstr  # http://hamstr.localhost:8795, seeded
```

`test`, `e2e` and `playground` build the app first; `server.mjs` then loads
`build/handler.js`.

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
  that opened them, so signing out ends them. Tickets are stored only as
  SHA-256.
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
- No Powerbox yet (grains requesting access to each other), no WebSockets
  (celld has none).
- A backup contains the item's data as stored, readable by anyone who has the
  file; restoring a hand-edited backup runs its `CREATE` statements (only
  `CREATE TABLE/INDEX/TRIGGER/VIEW` are accepted) in that item's own database.
