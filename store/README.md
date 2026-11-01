# Hamstr Store

**Little apps for your own Hamstr.**

The Hamstr Store is the hosted catalog for tiny, single-purpose web apps that
run on a personal [Hamstr](../hamstr/README.md) (or any
[celld-sites](../README.md) node). A publisher ships one packed bundle; an
admin presses **Get** in their Hamstr, or a developer runs one command. The
store never runs app code, and the app's data never leaves the user's machine.

The store is separate from the personal platform: people run Hamstr at home and
never run a store. One store serves many Hamstrs. Both look the same because
they share one design system ([`packages/ui`](../packages/ui)) and validate apps
with the same code ([`packages/app-format`](../packages/app-format)).

This directory is a working prototype: the catalog UI, publisher API, CLI and
the demo apps all run, and the test suites cover the store, the bundle format
and the installer path.

---

## 1. Requirements

### What people actually need

The pitch is right about the gap: a little tool is cheap to build and expensive
to *distribute safely*. The store exists to remove the distribution tax without
turning every utility into a SaaS account.

**Functional**

1. Browse and search published applets; read what an app does and what it can
   access before installing it.
2. Publish a built applet with a publisher account and an immutable version.
3. Install an applet into a local celld node with one command, from a public
   store, without building it locally.
4. Update an installed applet without losing its Durable Object data.
5. Withdraw a release (publisher) and remove one (moderator); report abuse.
6. Review releases before they appear in the catalog, with automatic checks
   that hold or block the obvious abuse (see §5, "Moderation").
7. Accounts only for publishing: browsing, trying and getting apps never
   need one.
8. Keep the app's code and data inspectable: a bundle is a tar.gz of the same
   files `tools/pack.ts` already produces; data is the node's own SQLite.

**Non-functional**

- **The store never executes publisher code.** No build step, no preview, no
  runtime on the store host. It stores bytes and metadata.
- **Install is verifiable.** SHA-256 from the catalog, every blob checked
  against its name, paths restricted, then the local deploy check runs the app
  in the celld isolate.
- **Permissions are explicit.** Egress is the only capability an app can
  request; the installer shows it and will not grant it without consent.
- **Cheap to self-host.** One container, one database, one blob directory.
  Without `DATABASE_URL` the store embeds Postgres (PGlite) in its data
  directory; with it, it uses a Postgres server it shares with the moderation
  site. No object store, no queue, no external auth provider.
- **Boring failure modes.** Store down: installed apps keep running; publishing
  and new installs fail. Node down: the store is unaffected.

**Out of scope for the prototype**

- Payments, ratings, comments, screenshots, verified publisher identity.
- Automatic building from source. (Deliberate: building untrusted code on the
  store host is remote code execution. See §7.)
- Federation between stores. The schema and blob layout are simple enough to
  mirror later.
- Per-app secrets. Apps run without secrets; an app that needs an API key does
  not belong in the store yet.

### Honest claims

- "0 MB idle" is true before an app is first opened and after celld sheds its
  isolate. A just-used isolate stays resident (celld keeps a small pool); do not
  promise zero RAM for a warm app.
- "Wakes in 4 ms" is a goal, not a measured promise; measure on the target node.
- "Isolated" means the celld isolate, per-site objects and the egress
  allowlist, not a VM boundary and **not yet a claim that hostile apps are
  safely contained**. Isolates share one process (see `docs/SECURITY.md`);
  hostile-app sandboxing is a goal. The official store moderates releases, but
  moderation is not a sandbox, and a self-hosted store may run without review.
  For mutually hostile publishers, run one node per trust tier.
- "Own the code" is true for the installed bundle; the optional source archive
  is what makes customization easy, and it is not required to run.
- "Public store" is a catalog, not hosting: publishers pay nothing because the
  user's node runs the app. The trade-off is that the user must run a Hamstr.

### Why not the obvious alternatives?

| Approach | Why not |
| --- | --- |
| One Docker container per app | 20 little tools × a runtime each = idle RAM, image pulls and a second package manager. That is the problem this is trying to avoid. |
| Host every app centrally | The store becomes responsible for everyone's data, accounts and uptime — the SaaS model the pitch rejects. |
| A single hosted multi-tenant app | Back to a login and a stranger's database for a Secret Santa list. |
| Desktop app bundles only | Loses the URL, sharing and the browser's reach; celld already gives each app a real origin and SQLite. |
| A plain Git repo of apps | No catalog, no install UX, no review, no version metadata; users still build on their own machine. |

The store is the smallest distribution layer that keeps the "folder is an app,
data is yours" property.

---

## 2. Architecture

```
 publisher                    Hamstr Store (hosted)                       user's Hamstr / celld node
 ─────────                    ─────────────────────                       ──────────────────────────
 hamstr publish ./app
   pack.ts + tar.gz  ──────▶  POST /apps/:pub/:app/releases (manifest)
                              PUT  /releases/:id/bundle (tar.gz)
                                validate tar: paths, types, sizes,
                                blob hashes, code.json, limits
                                store blobs/<sha256>.tgz
                                Postgres: publishers, apps, releases
   ◀────────────────────────  catalog JSON / download URL
                                                                    Get in Hamstr, or
                                                                    hamstr install pub/app --host h
                                                                      GET metadata + bundle
                                                                      verify sha256 + bundle
                                                                      show egress, consent
                                                                      set egress (admin API)
                                                                      push bundle ─────────▶  celld
                                                                                              deploy check,
                                                                                              activate,
                                                                                              isolated run
                                                                      record installed version
```

### Components

| Piece | Where | Job |
| --- | --- | --- |
| `server.ts` | store container | HTTP API, serves the web UI, blob files |
| `db.ts` | store, moderation | Postgres (a server, or embedded PGlite), the numbered migrations, the one-time import of an old SQLite `store.db` |
| `releases.ts` | store, moderation | the state changes both make: publish, reject, suspend, settings, the audit log |
| `moderation/` | moderation container | the LAN-only moderation site and the check worker (§5) |
| `web/` | store container | the web UI: a SvelteKit single-page app built on `packages/ui` (the same components as Hamstr's own store pages) |
| `../packages/app-format/manifest.ts` | store, CLI, Hamstr | `hamstr.json` schema and egress host rules |
| `../packages/app-format/bundle.ts` | store, CLI, Hamstr | tar.gz validation: safe paths, regular files only, size caps, blob hash equality, `code.json` cross-check |
| `cli/` | publisher/developer machine | the `hamstr` CLI (npm package `@hamstr/cli`, see [cli/README.md](cli/README.md)): register/login, publish (build + pack + upload), install into a celld node over its admin API or a compose stack, update/list/report. Needs no checkout of this repo |
| `celld-demo` (compose) | separate node | disposable per-session copies for "Try it"; own bucket/token, no egress |
| `test/fixtures/` | repo | apps the tests publish: `secret-santa` (one worker, one Durable Object) and `pinboard` (a Hamstr grain app). The demo apps (gym-log, bookmarks, …) live outside this repo |

The store joins only the Traefik network (it needs no app network and no bucket
access) and holds no celld admin token. It shares that bridge with the celld
container, so a compromised store could open a TCP connection to celld's HTTP
port; it cannot authorize an admin call, reach the S3 bucket or read site data.
The installer (Hamstr, or the CLI) is the only component that talks to both
sides. It runs on the user's side and holds the node's admin token; the store
never does.

### Getting an app (the non-technical path)

The store is a catalog. Installing needs write access to *your* node, so it
happens on your side: in [Hamstr](../hamstr/README.md). An admin opens
**Store** in their Hamstr (which browses this catalog), presses **Get**, and the
app lands on everyone's Home. On the store's own site, **Get on my Hamstr**
asks once for the visitor's Hamstr address (kept in that browser only) and
opens the app's page there.

Publishing still needs to build and pack the app (a build step is arbitrary code
execution), so `hamstr publish` remains the publisher path.

### Interactive demos

Every app entry gets a **Try it** button: the store deploys that exact
release to a disposable demo node, shows it for 15 minutes, and deletes it.
The demo is a full-screen route (`/demo/<id>`), not a modal: desktop embeds
the app in a full-bleed frame with a slim bar (countdown, new tab, end), while
phones get a native hand-off — the app opens in its own tab so forms, the
keyboard and scrolling behave like the real thing instead of fighting a nested
iframe. Browser back returns to the store page. Each visitor gets a random host
(`demo-<id>.<domain>`) and its own SQLite, so two sessions cannot see each
other's names or rounds.

- The demo node is a **separate celld instance** with its own bucket
  (`s3://celld-demo`), state volume and admin token. It never has access to
  production site data, and the store never holds the production admin token.
- Demos are **no egress**: an app that declares network hosts shows "install to
  try it" instead. This keeps the demo node from becoming an open proxy.
- Sessions are capped (`STORE_DEMO_MAX`, default 100 concurrent), rate-limited per
  IP (`STORE_DEMO_PER_HOUR`, default 10), and expire after `STORE_DEMO_TTL_SECS`
  (default 900). A cleanup loop deletes the site and runs the demo node's prune.
- Under load **Try it** disappears instead of failing: while every slot is
  taken, while the demo node reports memory pressure or is draining (read at
  most every 10 s from its admin state), and for two minutes after the node
  failed to start a demo. A page that still shows the button and gets a 503
  hides it and says demos are busy.
- The demo node gets 6 GB and 4 CPUs by default (`DEMO_MEM_LIMIT`, `DEMO_CPUS`).
  Measured on the development VM: ~120 MiB idle plus ~17 MiB per running, used demo.
- The iframe is sandboxed (`allow-scripts allow-forms allow-same-origin
  allow-popups`, no top navigation). The store's CSP only allows frames from the
  configured demo domain.
- By default the demo hostnames are LAN-only, as this stack ships them. Public
  demos need wildcard DNS and a wildcard tunnel/cert for `demo-*.<domain>`;
  the app itself (the iframe) must be reachable by the visitor.

API: `POST /api/v1/apps/:publisher/:app/demo` → `{id, url, expiresAt}`,
`GET /api/v1/demos/:id`, `DELETE /api/v1/demos/:id`. The app detail includes
`demo.available` and a reason when it is not.

### Data model

Postgres; the schema is `MIGRATIONS` in `db.ts`.

```
publishers(id, name UNIQUE, password_hash, created_at, policy_accepted_at,
           trusted, suspended_at, suspended_reason)
tokens(id, publisher_id, hash, kind cli|session, created_at, last_used_at, expires_at)
apps(id, slug UNIQUE, publisher_id, name, summary, description,
     homepage, source, license, icon, category, tags jsonb, created_at, updated_at)
app_tags(tag, app_id, PRIMARY KEY(tag, app_id))   -- index behind ?tag=
releases(id, app_id, version, manifest jsonb, status,
         bundle_sha, bundle_size, source_sha, source_size,
         created_at, published_at, downloads,
         reviewed_at, reviewed_by, review_note,
         UNIQUE(app_id, version))
reports(id, release_id, reason, created_at, resolved, resolved_at, resolved_by)
events(id, at, actor, action, target, note)            -- the audit log
moderation_checks(release_id PK, status, verdict allow|review|block, risk,
                  findings jsonb, classifier jsonb, action, error, ...)
settings(key PK, value jsonb, updated_at, updated_by)  -- registration, publishing
```

`status` is `uploading → pending → published`, then `yanked` (withdrawn: hidden,
downloads answer 410), `removed` (deleted by its publisher: files deleted,
downloads answer 404) or `rejected` (a moderator or the checks said no; the
publisher sees `review_note`, the bundle stays 30 days so the decision can be
reversed, then the store deletes it). A removed or rejected release keeps its
row and hashes, so its version is never free again.

An app's listing (name, summary, icon, tags, …) changes only when one of its
releases is published. A release waiting for review never changes what the
catalog shows.
A release row exists before its bundle does; the upload is the second step, so
a bad manifest fails before a large body is sent and abandoned uploads are
cleaned up after 24 hours.

### Names

Every app is `<publisher>/<app>` (`alice/my-app`): the publisher part
is the account that publishes it, the app part is the manifest's `slug`. A
manifest never names its namespace, so it cannot claim someone else's. Two
publishers can both have a `notes`; nobody can claim a bare `notes` for
everyone, which is where npm's squatting and typosquatting live.

That makes publisher names the thing impersonators go after, so registration
refuses reserved names (`hamstr`, `admin`, `official`, `support`, big brands,
also with suffixes like `-official` or `-app`) and names that read the same as
an existing one once dashes and look-alike characters are folded (`4lice`,
`alic3`, `alice-app`). Names one letter from another publisher's, or
containing a brand, are allowed but every release of theirs goes to a person
(see §5). Publisher names cannot be changed: they are part of every app's
address.

Apps from before namespaces still answer at their old bare address
(`/api/v1/apps/my-app`, `/apps/my-app`) by redirect; a new app never gets
one. Hamstr records the full name of every installed app and refuses an
"update" that would swap in another publisher's app of the same name.

### Bundle format

Exactly what `tools/pack.ts` writes and `node/push.sh` deploys:

```
version            12 hex chars; the router's version id
code.json          { compatibilityDate, source, files: { path: [sha256, type] }, ... }
blobs/<sha256>     each static file, named by its own hash
```

The store validates and stores that tar.gz unchanged. Nothing is rebuilt, so the
bytes the publisher tested are the bytes the user installs, and the hash in the
catalog is meaningful. The manifest (`hamstr.json`) is separate metadata and is
never placed inside the deployable bundle; an installer cannot be tricked by a
second copy of the metadata inside the archive.

### Publishing flow

1. `hamstr publish ./app` reads `hamstr.json`, runs the site build (unless
   `--no-build`), runs `tools/pack.ts`, creates a deterministic tar.gz and
   validates it with the same library the store uses.
2. `POST /api/v1/apps/:publisher/:app/releases` sends the manifest. The store validates
   it, checks ownership and quotas, and returns an upload URL.
3. `PUT .../bundle` streams the tar.gz (Content-Length required, bounded),
   hashes it, validates the archive, stores it by hash, and marks the release
   `published` (or `pending` in review mode). The moderation site checks it
   either way (§5).
4. A version can never be reused with different content: publishing an
   existing version fails, and deleting a release or an app only marks its
   releases `removed` (files deleted, version kept). A deleted app's name stays
   with its publisher, who can publish new versions to it. Abandoned uploads
   (no bundle after 24 hours) are the only releases deleted outright.

### Install flow

1. Resolve the app and release from the catalog.
2. Download; verify the catalog's SHA-256.
3. Validate the archive locally (same code): no traversal, no symlinks, bounded
   sizes, every blob equals its name, every blob referenced by `code.json`.
4. Show the declared egress hosts. If any are new and `--allow-egress` is not
   given, prompt on a TTY; without a TTY, refuse.
5. Set the node's egress allowlist for that site (allowed before the site exists,
   so the deploy check runs with the intended permissions).
6. Pipe the original tar.gz to `/app/push.sh`; celld runs the deploy check in a
   scratch object namespace, activates, and watches the live check path. On
   failure the previous egress list is restored.
7. Record `{slug, version, sha256, egress}` in `~/.config/hamstr/installed.json`
   (the CLI; Hamstr keeps its own record).

Updating reuses the same site id, so Durable Object data survives. This is the
same data model as a normal celld deploy.

---

## 3. API

Public reads, authenticated writes. Accounts exist only for publishing. The
CLI sends a token (`Authorization: Bearer cub_<id>_<secret>`; the prefix is
from the store's old name and kept so existing tokens stay valid); the web UI
signs in with a session cookie (`store_session`, HttpOnly, SameSite=Strict,
`Path=/api`, 30 days). Only the SHA-256 of either secret is stored. A session
never works as a Bearer token and a token never works as a cookie; a
cookie-signed request that changes anything must also carry the store's own
`Origin`. A suspended publisher's tokens and sessions are deleted, and signing
in answers 403 with the reason.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | – | liveness and counts |
| GET | `/api/v1/apps?q=&category=&tag=&limit=&offset=` | – | catalog search (`q` also matches tags) |
| GET | `/api/v1/categories` | – | the fixed categories with listed-app counts |
| GET | `/api/v1/apps/:publisher/:app` | – | app + published releases (owner token also sees pending) |
| GET | `/api/v1/apps/:publisher/:app/releases/:version/download` | – | bundle, `X-Bundle-Sha256` |
| GET | `/api/v1/apps/:publisher/:app/releases/:version/source` | – | optional source archive |
| POST | `/api/v1/publishers` | – | create a publisher (`acceptPolicy: true` required); returns a token once, or with `session: true` signs the web in |
| POST | `/api/v1/tokens` | – / session | password login, new CLI token; a web session gets one without the password |
| DELETE | `/api/v1/tokens` | token / session | revoke every CLI token |
| POST | `/api/v1/session` | – | web sign-in (sets the session cookie) |
| DELETE | `/api/v1/session` | session | sign out |
| GET | `/api/v1/me` | token / session | own apps, every release with its status and review note |
| POST | `/api/v1/me/password` | token / session | change the password; ends every other sign-in |
| POST | `/api/v1/apps/:publisher/:app/releases` | token | create release metadata (only under your own name) |
| PUT | `/api/v1/releases/:id/bundle` | token | upload tar.gz |
| PUT | `/api/v1/releases/:id/source` | token | optional source tar.gz |
| POST | `/api/v1/releases/:id/yank` | token | withdraw a release |
| DELETE | `/api/v1/releases/:id` | token | remove a release (files deleted, version stays taken) |
| DELETE | `/api/v1/apps/:publisher/:app` | token | remove an app from the catalog: every release removed, name kept for its publisher |
| POST | `/api/v1/apps/:publisher/:app/releases/:version/report` | – | abuse report (rate-limited), read on the moderation site |
| POST | `/api/v1/apps/:publisher/:app/demo` | – | start a throwaway demo session |
| GET | `/api/v1/demos/:id` | – | demo status, URL and expiry |
| DELETE | `/api/v1/demos/:id` | – | end a demo early |
The store has no admin endpoints: review, takedowns, suspensions and the
switches live on the moderation site (§5), which writes the same database.
Registration and publishing answer 503 while a moderator has paused them.

Publishing is rate-limited per publisher; registration, login, reports and
downloads per IP. Limits are in-memory and reset on restart.

### Manifest (`hamstr.json`)

```json
{
	"schema": 1,
	"slug": "secret-santa",
	"name": "Secret Santa",
	"summary": "Draw names for a gift exchange without an account.",
	"description": "Longer text, shown with preserved line breaks.",
	"version": "1.0.0",
	"license": "MIT",
	"icon": "🎁",
	"category": "family",
	"tags": ["gifts", "christmas"],
	"homepage": "https://example.com/secret-santa",
	"source": "https://example.com/source",
	"egress": ["api.example.com"]
}
```

`category` is one of the store's fixed sections, which make up its filter row:
`productivity`, `family`, `social`, `health`, `creative`, `games`, `money`,
`learning`, `tools`, `developer` (see `CATEGORIES` in
`packages/app-format/manifest.ts`). It is optional; an app without one is only
listed under *All*. `tags` (at most 8) are free keywords: search matches them,
and the app page links each to the apps sharing it, but they are never a
browse list, so their number does not matter.

Optional, for apps that run as [Hamstr](../hamstr/README.md) grains:
`permissions` (`[{ "id", "title", "description"? }]`, at most 16; the grain's
owner holds every one). The retired `roles` field is still accepted and
ignored. `instances` is `"many"` (the default: people make as many
grains as they like, one per document) or `"single"` (one grain per person,
opened straight from the Hamstr home screen, like Pinboard). `export` is a
path in the app (`"/export"`) that answers with one grain's data as a file;
Hamstr offers it to owners as *Download data*.

`devices` (`["microphone"]`) is for grains that need browser hardware. Hamstr
lists it in the install dialog like network hosts, asks the admin to allow it,
and only then lets the app's frame use it (`allow="microphone"`); the browser
still asks the person. Browsers only provide the microphone on https (or
localhost), so Hamstr warns, in plain words, when it is opened over http.

Strict by design: unknown fields are rejected so a typo cannot silently drop a
permission. `egress` and `devices` are the only permissions; Durable Objects and storage are
implicitly scoped to the app's site id. Egress entries must be public,
fully-qualified hostnames — no IPs, wildcards, ports, credentials, single
labels, internal suffixes or numeric TLDs.

---

## 4. Security model

| Asset | Who can reach it |
| --- | --- |
| Publisher password | only as a scrypt hash in the store DB |
| Publisher token, web session | shown once / HttpOnly cookie; only the SHA-256 is stored |
| Moderation | a separate LAN-only site; the public store has no admin surface |
| Bundles | public by design; deleted on takedown/yank when unreferenced |
| App code execution | only on a user's celld node, after install |
| App data | only the user's node; the store never sees it |
| Node admin token | never leaves the node; the store has no access |

- **Store compromise** exposes metadata and bundles (public anyway), not app
  data, not the node. It cannot deploy, and it holds no admin token. It shares
  the database with the moderation site, so it could also write moderation
  decisions: the database protects the catalog's integrity only as well as the
  store process does.
- **Demo compromise** is the demo node only: separate bucket, state and admin
  token, no production credentials. The demo node still executes app code in the
  celld isolate, so keep it resource-capped and ephemeral; a demo session is not
  a place for real data, and the isolate is not a claimed hostile-app sandbox.
- **Publisher compromise** can publish a new version under that publisher's
  apps and yank them; it cannot activate anything on users' nodes.
- **Malicious bundle**: never executed by the store; the installer validates
  structure and hashes, but the *code is untrusted*. The isolate, CPU limit and
  egress allowlist reduce what a bad app can do, but they are not yet a proven
  containment boundary for deliberately hostile code. Install shows requested
  hosts and `STORE_REQUIRE_REVIEW=1` matters for a public store, but neither is
  a sandbox.
- **Malicious archive**: regular files and directories only, no traversal,
  bounded compressed/uncompressed sizes and entry counts. The installer never
  extracts to disk — it pipes verified bytes to push.sh, which extracts inside
  the celld container.
- **Supply chain**: SHA-256 protects transport and storage integrity, not
  authorship. Signing (minisign/Sigstore) is the next step; do not describe the
  hash as a signature. Meanwhile the two paths most npm incidents took are
  narrowed: a trusted maintainer's account turning malicious (an update that
  asks for new network access, or one published right after a password change
  or with a token younger than three days, always goes to a person; §5), and a
  payload fetched after review (Hamstr holds a grain's browser code to the
  app's declared hosts, below).
- **Browser code**: Hamstr adds its own Content-Security-Policy to every grain
  response, next to any the app sends: scripts and fonts only from the grain
  itself, and connections, images, media and form posts only to the grain and
  the hosts the manifest declares (and their subdomains). Code loaded from a
  CDN after review does not run, and page code cannot send what people type to
  a host the install dialog never showed. Inline and eval'd scripts stay
  allowed: they can only come from the reviewed bundle. Navigation (links,
  `window.open`) cannot be restricted this way. Apps installed with the CLI
  straight into celld (not through Hamstr) do not get this policy yet.
- **Abuse**: automatic checks, review mode, reports, takedowns, suspensions,
  a registration/publishing switch, quotas, rate limits, a content policy every
  publisher accepts (`/policy`). A public store still needs a human on the
  other end; the code provides the levers (§5).
- **Privacy**: no email, no tracking pixels, no third-party scripts. Download
  counts are aggregate. Object names inside apps are not sent to the store.

Accepted for the prototype: one shared moderator password (names are typed at
sign-in and logged, not verified); in-memory rate limits; no password reset;
no email verification; no signing; no per-publisher storage billing. See §8.

---

## 5. Hosting the store and going public

A personal Hamstr does not run a store; it points `HAMSTR_STORE` at one. The
root `compose.yaml` includes the store (and its demo node) for the host that
operates it, behind the `store` compose profile:

```sh
# .env
COMPOSE_PROFILES=hamstr,store
STORE_HOST=store.example.com
STORE_DB_PASSWORD=<openssl rand -hex 24>
STORE_REQUIRE_REVIEW=0   # 1 for a public store
MODERATION_HOST=moderation.example.com   # LAN-only, never in the tunnel
MODERATION_PASSWORD=<openssl rand -base64 18>
DEMO_ADMIN_TOKEN=<openssl rand -hex 24>   # hex: the celld entrypoint allows [A-Za-z0-9_-]
DEMO_READ_TOKEN=<openssl rand -hex 24>
STORE_DEMO_DOMAIN=example.com

docker compose up -d --build store-db store moderation celld-demo
open https://store.example.com
```

The image is `store/Dockerfile` (build context: the repo root); it builds the
web UI and ships it with the server and the moderation site. Data lives in two
volumes: `store-pg` (Postgres: catalog, accounts, decisions, the log) and the
store's own (still named `celld-sites_cubby-data` from an old name: `blobs/`);
back up both. On its first start with an empty database the store imports an
old SQLite `store.db` from its data directory and renames it
`store.db.imported`. The containers are read-only except their volumes, run
unprivileged and drop all capabilities; Postgres is only on the project
network.

### Moderation

`store/moderation/` is a separate site on the same database: one more
container from the same image (`node store/moderation/server.ts`), with the
store's volume mounted read-only for the bundles. It is LAN-only and must stay
that way: it holds the keys to the catalog. Sign in with your name (logged with
every decision) and `MODERATION_PASSWORD`.

| Page | What |
| --- | --- |
| Queue | releases waiting for review, riskiest first |
| Flagged | published releases the checks flagged, or someone reported since |
| Reports | open reports; dismiss, or open the release |
| Blocked | rejected releases, by a moderator or the checks; reversible for 30 days |
| Publishers | accounts: suspend (signs them out, hides every app), lift, trust |
| Log | every action by publishers, the checks and moderators |
| Settings | pause new accounts or publishing; the check policy in effect |

A release page shows the listing, the findings with their evidence, the
classifier's answers, what changed since the previous version, and every file
of the bundle as escaped text (never run). Decisions: approve, reject or take
down with a reason the publisher sees on their account page, keep a flagged
release, run the checks again.

**Automatic checks.** Every release with a bundle gets one check when it
arrives, before or after publication:

1. Rules (`moderation/scan.ts`) read the listing, the pages and the code:
   a password field posting to another server, brand names next to a login,
   recovery-phrase and card-number fields, miners, obfuscation, decoded `eval`, trackers,
   remote scripts, redirects, risky egress hosts (paste sites, tunnels,
   webhooks). Each finding has a risk from 0 to 1 and names its file. Rules
   that need the database add: an update that asks for network access the
   previous version did not have, a release after a password change or with
   a fresh token (older accounts only), and a publisher name one letter from
   another's or carrying a brand. Each of these sends the release to a person
   even when its publisher is trusted.
2. An optional classifier (`moderation/jev.ts`): TypeSafe's Jev scores the
   release's state (listing, page text, form fields, hosts, the start of the
   server code) for harm and answers whether it impersonates a brand or asks
   for other services' secrets. Set `JEV_API_KEY` (and `JEV_URL`, `JEV_MODEL`
   for another endpoint) to turn it on. It is advisory and sends publisher
   content to that endpoint: do not point it at a free endpoint without data
   terms (such as OpenCode's) for real submissions.
3. The higher of the two risks decides: `block` from `MODERATION_BLOCK_AT`
   (0.9), `review` from `MODERATION_REVIEW_AT` (0.4), `allow` below.

Policy: `block` rejects the release at once (`MODERATION_AUTO_BLOCK=1`, the
default); the publisher reads only that the checks blocked it, moderators see
why. `allow` still waits for a person, except for publishers a moderator
marked trusted (`MODERATION_AUTO_APPROVE_TRUSTED=1`, the default) or everyone
with `MODERATION_AUTO_APPROVE=1`. With `STORE_REQUIRE_REVIEW=0` releases go
out at once and the checks run afterwards: `block` takes them down, `review`
lists them under Flagged.

The rules were tested on a handful of synthetic apps (`test/moderation.test.ts`).
They catch the crude cases and miss a careful attacker; the classifier has not
been measured on real submissions. Treat both as triage for a human, not as
the review. None of this is containment: the store cannot make an app safe to
run, and the runtime does not yet claim to sandbox hostile apps. On the official
public store, review and takedowns are the main risk reduction.

**Before making it public:**

1. Set `STORE_REQUIRE_REVIEW=1` and a strong `MODERATION_PASSWORD`; check that
   the moderation hostname resolves only on the LAN.
2. Read the content policy (`store/web/src/routes/policy`) and adjust it:
   every publisher accepts it when they register.
3. Add the store's hostname, and only that one, to the Cloudflare tunnel (the
   only step that makes it public; local DNS resolves it either way). Keep
   the node and the moderation site LAN/tailnet.
4. Put rate limits and a body-size limit at the edge as well as in the app.
5. Decide who answers reports and how fast; the moderation site has the
   levers, not the people.
6. Back up both store volumes and test a restore.
7. Consider a separate VM/container for the store; it should never hold the
   celld admin token or the bucket credentials. (It does not in this compose.)

The public store and the nodes are deliberately decoupled: one popular store can
serve many independent nodes, and a store going down does not stop installed
apps.

---

## 6. Limits (prototype defaults)

| Limit | Value |
| --- | --- |
| bundle compressed / unpacked | 32 MiB / 80 MiB |
| one static file / server code | 20 MiB / 16 MiB |
| archive entries | 5,000 |
| source archive | 16 MiB |
| apps per publisher | 20 |
| releases per app | 50 |
| publisher storage | 300 MiB |
| upload/registration rate | 120 uploads/h, 30 releases/h, 5 accounts/h/IP |
| store memory | 512 MiB container, 256 pids |
| demo sessions | 100 concurrent, 10/hour/IP, 15 min TTL, 100 objects/site, 20 s site timeout, node 6 GB / 4 CPUs |

These are constants in `server.ts`/`../packages/app-format/bundle.ts`; promote them to env vars
before running a public instance with different needs.

---

## 7. Why the store does not build

Running `npm install`/`npm run build` for an upload is arbitrary code execution
on the store host; `postinstall` is enough. The prototype therefore accepts only
a packed bundle, built by the publisher on their own machine or CI in a
throwaway container. The trade-off is that non-technical publishers need the
CLI — an acceptable v1 constraint for a store aimed at people who already build
little tools with an AI.

A future "build service" would need a disposable VM per build, no network during
build, a signed base image and a time/size cap. That is a separate project, not
a flag on this one.

---

## 8. Roadmap

1. **Signing** — publisher keys, detached signatures over the bundle hash;
   show "signed by" and refuse unsigned updates (opt-in policy).
2. **Per-publisher scoped tokens** and password reset; email optional.
   Moderator accounts instead of one shared password, an appeal path for
   rejected releases, and separate database roles so the public store cannot
   write moderation decisions.
3. **Source-first installs** — install from source with a sandboxed build, for
   users who want to read/modify before running.
4. **Screenshots and a richer manifest**, served from the bundle with a strict
   image type/size allowlist.
5. **Federation/mirrors** — content-addressed blobs already make mirroring
   cheap; add a signed catalog feed.
6. **Per-app egress tokens** — let a node operator grant `api.example.com` only
   to a specific app version, not just the site.
7. **Storage/egress quotas per app** in the celld router (the counts exist; bytes
   do not yet).
8. **Semver resolution and channels** (`latest`, `beta`) instead of "newest
   upload".

---

## 9. Development

```sh
npm install --prefix packages/app-format
npm install --prefix store
npm test --prefix store          # manifest, bundle, API and web-serving suites (node:test)
```

`store/test/api.test.ts` starts the real server on an ephemeral port with a
temporary data directory and exercises register → publish → catalog → download
→ yank → report → review/approve, web sessions and suspensions.
`store/test/moderation.test.ts` runs the store and the moderation site on one
database: the rules, the classifier client against a stand-in, and the whole
loop through the moderation site's forms. No Docker or celld node is required:
without a URL they use embedded Postgres. To run them against a Postgres
server (CI does), point `STORE_TEST_DATABASE_URL` at an empty database.

To run the moderation site next to a local store, use a Postgres server: an
embedded database belongs to one process.

```sh
DATABASE_URL=postgres://... STORE_DATA_DIR=/tmp/store node store/server.ts
DATABASE_URL=postgres://... STORE_DATA_DIR=/tmp/store PORT=3001 \
  MODERATION_PASSWORD=a-long-password node store/moderation/server.ts
```

The web UI:

```sh
npm install --prefix store/web
npm run build --prefix store/web       # → store/web/build, served by server.ts
# or, while working on it, with the API from `node store/server.ts` on :3000:
npm run dev --prefix store/web
```

It is a single-page app (`ssr = false`): `server.ts` serves the build and
answers every page path with `index.html`, whose one inline bootstrap script the
CSP allows by hash. Text from the API is rendered by Svelte (escaped); links use
only http(s) values the server validated.

End-to-end install (starts the store on an ephemeral port, publishes the demo
app through the real CLI, starts a throwaway `celld dev` node, installs it and
drives the app):

```sh
node store/test/e2e-install.ts
```

It uses `TEST_INSTALL_PORT` (default 8780) for the node and never touches the
compose stack. The same flow with the CLI as outside developers get it (packed
with `npm pack`, installed into an empty directory, run without this repo, the
node saved with `hamstr node`):

```sh
node store/test/e2e-cli-package.ts     # TEST_CLI_PORT, default 8781
```

With a compose stack instead of a node URL, `hamstr install --compose-dir <dir>`
uses `docker compose exec celld /app/push.sh` there, like `tools/deploy.sh`.

CI (`.github/workflows/test.yml`) runs the unit suites, the router API suite,
both CLI end-to-end tests, Hamstr's end-to-end test (each against `celld dev`,
the binary copied out of the celld image the node uses), the names service
against Pebble, and builds the store, Hamstr and names images.
