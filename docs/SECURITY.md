# Security model

What a site can reach, what it can break, and what an operator has to decide
before running someone else's code. This is the reasoning behind the
"Security" section of the README and the limits in `router/index.ts`; treat the
code as authoritative when they disagree.

## Trust levels

| Level | Who | Runs where |
| --- | --- | --- |
| Operator | holds `ADMIN_TOKEN`, the bucket, the host | everywhere |
| Site author | writes the worker and Durable Object code | site isolate |
| Visitor | sends requests | anywhere |

The platform is built for **operator and site author being the same person**.
Running a site you did not write (an app store, a third-party template, a
customer's code) moves that site into a hostile-code threat model. The runtime
boundary below is the part that has been hardened for that; the deploy path and
the node's process are not (see "Hostile tenant checklist").

## What is isolated

Each site version runs as a Dynamic Worker isolate. The isolate gets:

- `ASSETS` — a service binding to the site's own version's files, fixed by the
  router; it cannot ask for another version or site.
- `OBJECTS` — `call(className, name, method, ...args)`. The `site` part of the
  object key is fixed by the router from the `Host` header, so a site cannot
  address another site's Durable Objects even by guessing names. Class and
  method must be identifiers, names are limited to 200 characters.
- no outbound network unless the operator allowlists hosts for that site.
  `fetch()` throws with `globalOutbound: null`; with a list, requests go through
  `SiteEgress`, which allows only those exact hostnames, only `https:` on port
  443, refuses IP literals and internal names (including numeric host forms such
  as `127.1`), and does not follow redirects (the site follows them, so every
  hop is checked). `connect()`, WebSockets and sockets stay unavailable,
  including from Durable Object code. Changing the list clears the cache and
  aborts every indexed Durable Object of that site, so a running facet (and its
  pending timers) cannot keep using the old allowlist.
- no KV, D1, R2, Queues, secrets, filesystem or process environment. The
  router's `env` (KV, loader, operator URL, tokens) is not visible to the site.
- a minimal request context: `waitUntil`, `abort`, `passThroughOnException`.
  `ctx.exports` and `ctx.props` are dropped, so a future celld release cannot
  hand the router's own exports to site code through that route.
- 1 s of CPU per request (site or Durable Object call), 1000 subrequests per
  request (Durable Object calls plus egress fetches; `SITE_MAX_SUBREQUESTS`),
  30 s wall clock to start a response (`SITE_TIMEOUT_SECS`), and 128 concurrent
  requests per site per router isolate (`SITE_MAX_INFLIGHT`, above that: 503).
- at most `SITE_MAX_OBJECTS` (default 1000) Durable Objects per site, claimed
  atomically in a reserved Durable Object (concurrent first calls cannot exceed
  it). Each object is a separate SQLite database with its own write log in the
  bucket, so this bounds the databases a site can create, not the bytes inside
  them.
- static deploy paths with `..` segments or backslashes are refused, and such
  request paths are answered 404 before any lookup.

Deploy checks run the new version with its Durable Objects under a scratch site
id (`~check~site~version`), so they cannot touch live data. The admin API only
answers on `ADMIN_HOST` (`admin.internal`), which Traefik never routes, and needs
a bearer token whose SHA-256 hash is the only form stored. `admin.internal` is
not accepted as a site id.

## Deploy API invariants

These hold even for a control plane that holds the admin token, so a bug in it
cannot silently cross tenants:

- **Versions are immutable.** `code:<version>` is written once. Re-uploading an
  identical record (the unchanged-build case) is a no-op; different content for
  an existing id is `409`. `check` is deploy metadata, not part of the id, so
  changing only that in `celld.json` updates the record instead of failing. The
  one exception is upgrading a pre-file-list (legacy) version to the blob
  format, and only while it is not live; a live legacy version needs a new
  version id (change the content or the compatibility date).
- **Activation is bound to a site.** `activate` (and `check`) accept a version
  only if it was staged for that site (`PUT /code?host=`, `POST /stage`) or is
  in the site's deploy history (rollback). A bundle built for site B cannot run
  with site A's Durable Objects by calling `activate`. Deploy endpoints refuse
  an alias hostname (`409`), so "deploy for vanity.test" cannot silently change
  the site it points at; use the site id. At most 20 versions may be staged per
  site. `POST /stage` is still an explicit re-binding, available only to the
  admin token: this stops accidents, not a holder of that token.
- **`prune` is explicit and numeric.** It requires `confirm=prune`, rejects
  non-integer `keep`/`orphanAge`/`stagedAge` (no silent default to 0), keeps
  versions staged for a deploy younger than `stagedAge` (default an hour), and
  only then deletes unreferenced versions, history past 100 entries per site,
  blobs and index records.
- **Deploy checks exercise the worker.** If the default check path (`/`) is a
  static file (every SvelteKit/Nuxt build has an `index.html`), the check also
  requests `/~check-<version>`, so a worker that 500s everywhere fails the
  deploy even though `/` is served statically. A custom `check` path is used as
  given.

## What is not isolated

These are accepted for self-hosted, first-party sites. They matter for a store.

Apps installed from the Hamstr Store land on the same node as your own sites, so
every item below applies to them too. Mitigations in place: the CLI refuses to
install over a site it did not create (unless `--replace`), both the CLI and
Hamstr refuse a release without a published SHA-256, and Hamstr asks an admin
before granting an app internet access. The hash comes
from the same store as the bundle, so it detects corruption, not a malicious
store. Real separation needs a second node (the `celld-demo` pattern). Router
quotas cannot close items 1 and 2: Durable Object writes and isolate memory
never pass through the router.

1. **One process, one heap, one disk.** Isolates are a capability boundary, not
   a fault boundary. A site can allocate up to the V8 heap limit (celld default
   128 MB, this repo sets 256 MB) **and beyond it with ArrayBuffers, which are
   not counted against that limit** — measured 1.5 GB in one request and 3 GB
   resident across requests on `celld dev` with the node still healthy. Work
   scheduled with `waitUntil` keeps running after the response and is not
   covered by the 1 s CPU cap (measured 12 s of work and +275 MB RSS after a
   3 ms response), and a response body has no size or duration cap once headers
   are sent. CPU is capped per request, not per site per second; the node is
   finally bounded by `CELLD_MEM_LIMIT` (8 GB) and the container's disk. A few
   hostile apps can pressure the node or make celld shed Durable Objects.
2. **Storage is not quota'd by bytes.** Object count is capped atomically, but
   one object can write unlimited SQLite data (a single SQL value is 2 MB; one
   object wrote 40 MB), and celld 0.6.3 never compacts Durable Object facet
   write logs (~4-6 KB per write, and 1000 empty objects cost ~236 MB of disk).
   A chatty app can fill the bucket. The only stop today is monitoring (the
   dashboard) plus `DELETE /__admin/site`, which stops serving and deletes
   data — a kill switch, not a quota.
3. **The deploy path is operator-trusted.** `tools/deploy.sh` runs
   `npm run build` on the host as the operator, so a third-party site's
   `postinstall` or build script is code execution on the VM. `tools/pack.ts`
   refuses symlinks and large files, but it runs after the build. The admin
   token is one global secret: anyone who can deploy can deploy any site. The
   invariants above keep an individual call from crossing sites, but there is no
   per-publisher token or ownership check; a control plane must implement that
   itself.
4. **No per-site secrets.** Site code and data are readable by the operator and
   stored in the bucket in plaintext. An app that needs an API key or OAuth
   token has nowhere safe to keep it.
5. **Egress is name-based.** An allowlisted name whose DNS later resolves to a
   private address (DNS rebinding) is not caught by the name check;
   HTTPS-on-443-only keeps it away from celld's plain-HTTP operator API, but not
   from other HTTPS services on the LAN. Only allowlist names whose DNS you
   control, or leave egress off. Changing the list aborts idle objects, but a
   call that is already executing keeps the old proxy until it returns (bounded
   by the object timeout, 24 s by default).
6. **The bucket is the source of truth and is not encrypted by this platform.**
   VersityGW stores objects as files in a Docker volume; VM backups cover them.
   Disk encryption and backup access are host-level concerns. Object names are
   site-chosen and stored in plaintext in the index; `/__admin/overview`
   returns them to `READ_TOKEN`, and the LAN dashboard (behind a password) shows
   them. Do not put secrets or unnecessary user identifiers in object names.

## Proxy-only sites (Hamstr grains)

Sites whose id starts with `PROXY_SITE_PREFIX` (default `grain-`) answer only
requests carrying `x-celld-proxy-token`, whose SHA-256 is the router's
`PROXY_TOKEN_SHA256`; anything else gets the same 404 as a missing site, aliases
included. The router strips the header before site code runs, on every site.
This is what lets [Hamstr](../hamstr/README.md) hand apps identity headers they
can trust: another container on the bridge cannot reach a grain directly or
forge them. Without `PROXY_TOKEN` grain sites answer nobody.

## Home mode (no sign-in)

`HAMSTR_AUTH=none` turns sign-in off: anyone who can reach Hamstr's port is its
owner and can install apps, grant egress, and read or delete every grain. Only
use it on a network where everyone is trusted. Grains are told apart by port:
browsers keep their storage and scripts apart (separate origins), but share
cookies across ports, so a grain can read and set another grain's cookies.
The grain proxy still refuses cross-origin writes, and the shell API still
refuses requests from other origins, including grains.

## Sign-in (Hamstr accounts)

Sites that declare `auth` in `celld.json` get a verified identity from the
router. The pieces and what each is trusted for:

- **Hamstr** (LAN-only, `hamstr/lib/auth`). Authenticates people, decides who
  may enter which site, and mints short-lived tokens. It already holds the
  celld `ADMIN_TOKEN` and the proxy token; sign-in adds `AUTH_KEY`.
- **Router.** Only verifies HMAC-signed tokens with `AUTH_KEY`; it never calls
  Hamstr. The mode (`required`/`optional`) is per site in KV
  (`auth:<site>`): set from `celld.json` when a deploy is activated, overridable
  from Hamstr's Settings, never stored on the content-addressed code record that
  several sites may share. Three token types, each bound to a type and a hostname
  (`aud`): `authreq` (router to Hamstr: "this host wants a person"; signed
  so a visitor cannot ask for another site's policy or an open redirect),
  `handoff` (30 s, single use per router isolate) and the `site` cookie (15 min).
- **Site code** never sees the key or the cookie. The router strips every
  `x-celld-user-*` header from incoming requests and the cookie from the
  forwarded request, then sets the headers itself.

Design choices and limits:

- The cookie is **host-only** (`__Host-` over https), `HttpOnly`,
  `SameSite=Lax`. There is deliberately no shared parent-domain cookie: sibling
  sites are mutually untrusted tenants, and a `.domain` cookie would be sent to
  all of them.
- Spoofing: a site cannot mint a token (no key), and a token for host A fails
  on host B (`aud`). Headers on the incoming request are always removed.
- CSRF: Hamstr's JSON API refuses cross-site requests
  (`Sec-Fetch-Site`/`Origin`); provider logins carry a `state` bound to the
  browser by a cookie, so a login started by someone else cannot be completed in
  your browser. Sites remain responsible for CSRF on their own POSTs;
  `SameSite=Lax` covers cross-site form posts.
- Who may enter is decided only from Hamstr's own accounts database, so an
  unreachable or misconfigured celld admin API cannot open a restricted site; a
  rule is pushed to the router before it is saved, so it never looks live when
  the router did not take it.
- Provider protocols are not hand-rolled: OIDC goes through `openid-client`
  (discovery, PKCE, state, nonce and ID token claims; plain http only for an
  issuer on loopback) and passkeys through `@simplewebauthn/server`.
- Revocation is delayed by up to the site cookie lifetime (15 minutes). Handoff
  single-use is enforced per router isolate in memory, which is enough on one
  node but not a distributed guarantee; the 30 s lifetime and `aud` binding
  bound the damage of a leaked link.
- Identities are never linked by email automatically: an unknown login from any
  provider lands in a queue (or follows an invite, or the provider's
  auto-approve setting) so a provider that does not verify emails cannot take
  over an existing person. The first person to sign in on a fresh install
  becomes the owner, so do that before sharing the address.
- Provider client secrets are encrypted at rest with a key derived from
  `HAMSTR_SECRET`. Rotating `AUTH_KEY` only invalidates tokens in flight and
  site cookies (people sign in to sites again); rotating `HAMSTR_SECRET` needs
  the provider secrets re-entered.

## Hostile tenant checklist

Before running untrusted apps on a shared node:

- Build in a throwaway container with no network, no host mounts except the
  output, and no docker socket. Do not `npm install` a hostile app on the host.
- Keep egress off per app by default; allowlist only what the app declares, on
  names you control. Prefer apps that bundle their dependencies.
- Set `SITE_MAX_OBJECTS`, `SITE_MAX_INFLIGHT` and `SITE_MAX_SUBREQUESTS` to the
  smallest values the app works with, and watch bucket growth (the
  dashboard) rather than trusting the quotas to bound bytes. The in-flight cap
  is per router isolate (celld keeps a pool of ~10), so the effective ceiling is
  roughly ten times the value.
- Watch node memory too: ArrayBuffers and `waitUntil` work are not covered by
  the V8 heap limit or the per-request CPU cap. If an app does not need
  background work, treat `waitUntil` as a risk in review; a per-site memory
  budget would need cgroup-per-node isolation.
- Treat the admin token as root of the platform: a control plane that holds it
  must authenticate publishers and scope what they can deploy. Prefer a separate
  celld node (own bucket, own process) per trust tier over one node for
  everything; that is the only real fix for item 1.
- Review or sign the bundle you deploy (a hash of every file is already in the
  code record), and keep the operator out of app secrets by not pretending the
  platform has a secret store yet.

## Reporting and testing

The API and security regression suites run against a throwaway local node:

```sh
npm test --prefix tools     # tests/api.test.ts and tests/security.test.ts
```

`tests/security.test.ts` covers the request-context surface, admin API
hostname isolation, path traversal, object quotas and the in-flight cap. A red
team report from an adversarial pass lives outside the repo; when a finding is
fixed, add a regression test here rather than only in the report.
