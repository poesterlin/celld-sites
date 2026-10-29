# Cubby

**Little apps, in their own cubby.**

Cubby is a public catalog and installer for tiny, single-purpose web apps that
run on a [celld-sites](../README.md) node. A publisher ships one packed bundle;
a user runs one command to install it locally. The store never runs app code,
and the app's data never leaves the user's machine.

This directory is a working prototype: the catalog UI, publisher API, CLI and
the demo app all run, and the test suites cover the store, the bundle format and
the installer path.

> **Working name.** "Cubby" is a placeholder chosen for the metaphor (a small
> compartment for little things; a folder is an app). Check domain and trademark
> availability before launching publicly. Alternatives considered: AppDrawer,
> Minimart, Tuck, Nook (the last two have existing uses).

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
5. Withdraw a release (publisher) and remove one (operator); report abuse.
6. Optionally review releases before they appear in the catalog.
7. Keep the app's code and data inspectable: a bundle is a tar.gz of the same
   files `tools/pack.mjs` already produces; data is the node's own SQLite.

**Non-functional**

- **The store never executes publisher code.** No build step, no preview, no
  sandbox on the store host. It stores bytes and metadata.
- **Install is verifiable.** SHA-256 from the catalog, every blob checked
  against its name, paths restricted, then the local deploy check runs the app
  in the celld sandbox.
- **Permissions are explicit.** Egress is the only capability an app can
  request; the installer shows it and will not grant it without consent.
- **Cheap to self-host.** One container, one SQLite file, one blob directory.
  No object store, no queue, no external auth provider.
- **Boring failure modes.** Store down: installed apps keep running; publishing
  and new installs fail. Node down: the store is unaffected.

**Out of scope for the prototype**

- Payments, ratings, comments, screenshots, verified publisher identity.
- Automatic building from source. (Deliberate: building untrusted code on the
  store host is remote code execution. See §7.)
- Federation between stores. The schema and blob layout are simple enough to
  mirror later.
- Per-app secrets. Apps run without secrets; an app that needs an API key does
  not belong in Cubby yet.

### Honest claims

- "0 MB idle" is true before an app is first opened and after celld sheds its
  isolate. A just-used isolate stays resident (celld keeps a small pool); do not
  promise zero RAM for a warm app.
- "Wakes in 4 ms" is a goal, not a measured promise; measure on the target node.
- "Sandboxed" means the celld isolate and egress allowlist, not a VM boundary:
  isolates share one process (see the root `docs/SECURITY.md`). For mutually
  hostile publishers, run one node per trust tier.
- "Own the code" is true for the installed bundle; the optional source archive
  is what makes customization easy, and it is not required to run.
- "Public store" is a catalog, not hosting: publishers pay nothing because the
  user's node runs the app. The trade-off is that the user must run a node and a
  CLI.

### Why not the obvious alternatives?

| Approach | Why not |
| --- | --- |
| One Docker container per app | 20 little tools × a runtime each = idle RAM, image pulls and a second package manager. That is the problem this is trying to avoid. |
| Host every app centrally | The store becomes responsible for everyone's data, accounts and uptime — the SaaS model the pitch rejects. |
| A single hosted multi-tenant app | Back to a login and a stranger's database for a Secret Santa list. |
| Desktop app bundles only | Loses the URL, sharing and the browser's reach; celld already gives each app a real origin and SQLite. |
| A plain Git repo of apps | No catalog, no install UX, no review, no version metadata; users still build on their own machine. |

Cubby is the smallest distribution layer that keeps the "folder is an app,
data is yours" property.

---

## 2. Architecture

```
 publisher                    Cubby store (public, LAN by default)        user's celld node
 ─────────                    ─────────────────────────────────────        ─────────────────
 cubby publish ./app
   pack.mjs + tar.gz  ──────▶  POST /apps/:slug/releases (manifest)
                              PUT  /releases/:id/bundle (tar.gz)
                                validate tar: paths, types, sizes,
                                blob hashes, code.json, limits
                                store blobs/<sha256>.tgz
                                SQLite: publishers, apps, releases
   ◀────────────────────────  catalog JSON / download URL
                                                                    cubby install app --host h
                                                                      GET metadata + bundle
                                                                      verify sha256 + bundle
                                                                      show egress, consent
                                                                      set egress (admin API)
                                                                      push bundle ─────────▶  celld
                                                                                              deploy check,
                                                                                              activate,
                                                                                              sandboxed run
                                                                      record installed version
```

### Components

| Piece | Where | Job |
| --- | --- | --- |
| `server.mjs` | store container | HTTP API + static catalog UI, SQLite, blob files |
| `lib/manifest.mjs` | store + CLI | `cubby.json` schema and egress host rules |
| `lib/bundle.mjs` | store + CLI | tar.gz validation: safe paths, regular files only, size caps, blob hash equality, `code.json` cross-check |
| `cli/cubby.mjs` | publisher/user machine | register/login, publish (build + pack + upload), install/update/list/report |
| `shelf.mjs` + `shelf-public/` | the node (LAN-only) | web UI: browse, install, update, open, remove; no CLI, no token in the browser |
| `celld-demo` (compose) | separate node | disposable per-session copies for "Try it live"; own bucket/token, no egress |
| `public/` | store container | framework-free catalog UI |
| `examples/secret-santa/` | repo | demo applet: one worker, one Durable Object, no egress |

The store joins only the Traefik network (it needs no app network and no bucket
access) and holds no celld admin token. It shares that bridge with the celld
container, so a compromised store could open a TCP connection to celld's HTTP
port; it cannot authorize an admin call, reach the S3 bucket or read site data.
The installer (CLI or shelf) is the only component that talks to both sides. The
shelf runs on the node and holds the admin token; the store never does.

### Cubby Shelf (the non-technical path)

The public store is a catalog. Installing needs write access to *your* node, so
it belongs on your side. The shelf is a small LAN-only web app in the same
compose file:

- open `https://cubby-shelf.<domain>` (Tailscale/LAN), sign in with
  `CUBBY_SHELF_PASSWORD`;
- browse the public catalog, press **Install**, accept the hostname and any
  network permission;
- **Installed** lists apps with **Open**, **Update** and **Remove**;
- updates keep the app's Durable Object data; remove deletes the site (typed
  hostname confirmation).

It calls the same `cubby install` code and `push.sh` deploy path, with the admin
token on the server side. The browser never sees a token, never runs a command,
and never gets the admin API. The shelf is deliberately *not* public: it holds
`ADMIN_TOKEN`, so it stays off the tunnel, behind the password and on
`traefik_web` + `default` only.

Publishing still needs to build and pack the app (a build step is arbitrary code
execution), so `cubby publish` remains the publisher path. The shelf could grow a
"pick a site folder on this host" publisher later, with a build sandbox.

### Interactive demos

Every app entry gets a **Try it live** button: the store deploys that exact
release to a disposable demo node, shows it for 15 minutes, and deletes it.
The demo is a full-screen route (`/#/demo/<id>`), not a modal: desktop embeds
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
- Sessions are capped (`CUBBY_DEMO_MAX`, default 8 concurrent), rate-limited per
  IP (`CUBBY_DEMO_PER_HOUR`, default 6), and expire after `CUBBY_DEMO_TTL_SECS`
  (default 900). A cleanup loop deletes the site and runs the demo node's prune.
- The iframe is sandboxed (`allow-scripts allow-forms allow-same-origin
  allow-popups`, no top navigation). The store's CSP only allows frames from the
  configured demo domain.
- Temporarily the demo hostnames are LAN-only, like everything else here. Public
  demos need wildcard DNS and a wildcard tunnel/cert for `demo-*.<domain>`;
  the app itself (the iframe) must be reachable by the visitor.

API: `POST /api/v1/apps/:slug/demo` → `{id, url, expiresAt}`,
`GET /api/v1/demos/:id`, `DELETE /api/v1/demos/:id`. The app detail includes
`demo.available` and a reason when it is not.

### Data model

```
publishers(id, name UNIQUE, password_hash, created_at)
tokens(id, publisher_id, hash, created_at, last_used_at)
apps(id, slug UNIQUE, publisher_id, name, summary, description,
     homepage, source, license, icon, tags, created_at, updated_at)
releases(id, app_id, version, manifest, status,
         bundle_sha, bundle_size, source_sha, source_size,
         created_at, published_at, downloads,
         UNIQUE(app_id, version))
reports(id, release_id, reason, created_at, resolved)
events(id, at, actor, action, target, note)
```

`status` is `uploading → pending → published → yanked`, with `removed` reserved
for operator deletion (the prototype hard-deletes after logging the event).
A release row exists before its bundle does; the upload is the second step, so
a bad manifest fails before a large body is sent and abandoned uploads are
cleaned up after 24 hours.

Apps are globally unique slugs (`secret-santa`), owned by one publisher. The
prototype chooses global names for short install commands; a real launch should
decide between global squatting and `publisher/app` names.

### Bundle format

Exactly what `tools/pack.mjs` writes and `node/push.sh` deploys:

```
version            12 hex chars; the router's version id
code.json          { compatibilityDate, source, files: { path: [sha256, type] }, ... }
blobs/<sha256>     each static file, named by its own hash
```

The store validates and stores that tar.gz unchanged. Nothing is rebuilt, so the
bytes the publisher tested are the bytes the user installs, and the hash in the
catalog is meaningful. The manifest (`cubby.json`) is separate metadata and is
never placed inside the deployable bundle; an installer cannot be tricked by a
second copy of the metadata inside the archive.

### Publishing flow

1. `cubby publish ./app` reads `cubby.json`, runs the site build (unless
   `--no-build`), runs `tools/pack.mjs`, creates a deterministic tar.gz and
   validates it with the same library the store uses.
2. `POST /api/v1/apps/:slug/releases` sends the manifest. The store validates
   it, checks ownership and quotas, and returns an upload URL.
3. `PUT .../bundle` streams the tar.gz (Content-Length required, bounded),
   hashes it, validates the archive, stores it by hash, and marks the release
   `published` (or `pending` in review mode).
4. A version id can never be reused with different content. A release can be
   yanked; the blob is deleted when no release references it.

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
7. Record `{slug, version, sha256, egress}` in `~/.config/cubby/installed.json`.

Updating reuses the same site id, so Durable Object data survives. This is the
same data model as a normal celld deploy.

---

## 3. API

Public reads, token-authenticated writes. Tokens are `cub_<id>_<secret>`; only
the SHA-256 of the secret is stored, and publishers are looked up by token id.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | – | liveness and counts |
| GET | `/api/v1/apps?q=&tag=&limit=&offset=` | – | catalog search |
| GET | `/api/v1/apps/:slug` | – | app + published releases (owner token also sees pending) |
| GET | `/api/v1/apps/:slug/releases/:version/download` | – | bundle, `X-Cubby-Sha256` |
| GET | `/api/v1/apps/:slug/releases/:version/source` | – | optional source archive |
| POST | `/api/v1/publishers` | – | create publisher, returns token once |
| POST | `/api/v1/tokens` | – | password login, new token |
| DELETE | `/api/v1/tokens` | token | revoke all tokens |
| GET | `/api/v1/me` | token | own apps incl. pending releases |
| POST | `/api/v1/apps/:slug/releases` | token | create release metadata |
| PUT | `/api/v1/releases/:id/bundle` | token | upload tar.gz |
| PUT | `/api/v1/releases/:id/source` | token | optional source tar.gz |
| POST | `/api/v1/releases/:id/yank` | token | withdraw a release |
| DELETE | `/api/v1/releases/:id` | token | delete a release |
| DELETE | `/api/v1/apps/:slug` | token | delete app, releases and data in the store |
| POST | `/api/v1/apps/:slug/releases/:version/report` | – | abuse report (rate-limited) |
| POST | `/api/v1/apps/:slug/demo` | – | start a throwaway demo session |
| GET | `/api/v1/demos/:id` | – | demo status, URL and expiry |
| DELETE | `/api/v1/demos/:id` | – | end a demo early |
| GET | `/api/v1/admin/pending` | admin | review queue |
| GET | `/api/v1/admin/reports` | admin | open reports |
| POST | `/api/v1/admin/releases/:id/approve` | admin | publish a pending release |
| DELETE | `/api/v1/admin/releases/:id` | admin | takedown |
| POST | `/api/v1/admin/reports/:id/resolve` | admin | close a report |

`CUBBY_ADMIN_TOKEN` enables the admin routes; without it they answer 503.
Publishing is rate-limited per publisher; registration, login, reports and
downloads per IP. Limits are in-memory for the prototype and reset on restart.

### Manifest (`cubby.json`)

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
	"tags": ["family", "fun"],
	"homepage": "https://example.com/secret-santa",
	"source": "https://example.com/source",
	"egress": ["api.example.com"]
}
```

Optional, for apps that run as [Hamstr](../hamstr/README.md) grains:
`permissions` (`[{ "id", "title", "description"? }]`, at most 16) and `roles`
(`[{ "id", "title", "description"?, "permissions": [ids], "default"? }]`, at
most 8, `owner` is reserved). The grain's owner holds every permission; Hamstr
no longer has share links, so `roles` are validated but unused. `instances` is `"many"` (the default: people make as many
grains as they like, one per document) or `"single"` (one grain per person,
opened straight from the Hamstr home screen, like Pinboard). `export` is a
path in the app (`"/export"`) that answers with one grain's data as a file;
Hamstr offers it to owners as *Download data*.

Strict by design: unknown fields are rejected so a typo cannot silently drop a
permission. `egress` is the only permission; Durable Objects and storage are
implicitly scoped to the app's site id. Egress entries must be public,
fully-qualified hostnames — no IPs, wildcards, ports, credentials, single
labels, internal suffixes or numeric TLDs.

---

## 4. Security model

| Asset | Who can reach it |
| --- | --- |
| Publisher password | only as a scrypt hash in the store DB |
| Publisher token | shown once; only its SHA-256 is stored |
| Bundles | public by design; deleted on takedown/yank when unreferenced |
| App code execution | only on a user's celld node, after install |
| App data | only the user's node; the store never sees it |
| Node admin token | never leaves the node; the store has no access |

- **Store compromise** exposes metadata and bundles (public anyway), not app
  data, not the node. It cannot deploy, and it holds no admin token.
- **Shelf compromise** is node compromise: it holds `ADMIN_TOKEN`. Keep it
  LAN/tailnet-only, use a strong `CUBBY_SHELF_PASSWORD` and a random
  `CUBBY_SHELF_SECRET`, and never add its hostname to the tunnel.
- **Demo compromise** is the demo node only: separate bucket, state and admin
  token, no production credentials. The demo node still executes untrusted app
  code in the celld sandbox, so keep it resource-capped and ephemeral; a demo
  session is not a place for real data.
- **Publisher compromise** can publish a new version under that publisher's
  apps and yank them; it cannot activate anything on users' nodes.
- **Malicious bundle**: never executed by the store; the installer validates
  structure and hashes, but the *code is untrusted*. The celld isolate, CPU
  limit and egress allowlist are the real boundary. This is why install shows
  requested hosts and why `CUBBY_REQUIRE_REVIEW=1` matters for a public store.
- **Malicious archive**: regular files and directories only, no traversal,
  bounded compressed/uncompressed sizes and entry counts. The installer never
  extracts to disk — it pipes verified bytes to push.sh, which extracts inside
  the celld container.
- **Supply chain**: SHA-256 protects transport and storage integrity, not
  authorship. Signing (minisign/Sigstore) is the next step; do not describe the
  hash as a signature.
- **Abuse**: reports, takedown, review mode, quotas, rate limits. A public
  store needs a policy and a human on the other end; the code only provides the
  levers.
- **Privacy**: no email, no tracking pixels, no third-party scripts. Download
  counts are aggregate. Object names inside apps are not sent to the store.

Accepted for the prototype: the single admin token is root; in-memory rate
limits; no password reset; no email verification; no signing; no per-publisher
storage billing. See §8.

---

## 5. Self-hosting and going public

The root `compose.yaml` adds two LAN-only services: `cubby` (public catalog) and
`cubby-shelf` (the local install UI):

```sh
# .env
CUBBY_HOST=cubby.example.com
CUBBY_ADMIN_TOKEN=<openssl rand -base64 24>
CUBBY_REQUIRE_REVIEW=0   # 1 for a public store
CUBBY_SHELF_HOST=cubby-shelf.example.com
CUBBY_APP_DOMAIN=example.com
CUBBY_SHELF_PASSWORD=<openssl rand -base64 24>
CUBBY_SHELF_SECRET=<openssl rand -base64 32>
DEMO_ADMIN_TOKEN=<openssl rand -hex 24>   # hex: the celld entrypoint allows [A-Za-z0-9_-]
DEMO_READ_TOKEN=<openssl rand -hex 24>
CUBBY_DEMO_DOMAIN=example.com

docker compose up -d --build cubby cubby-shelf celld-demo
open https://cubby-shelf.example.com   # install UI
open https://cubby.example.com         # public catalog
```

Data lives in the `cubby-data` volume (`cubby.db` + `blobs/`); back it up like
any other service. The container is read-only except that volume, runs as the
`node` user, drops all capabilities and joins only `traefik_web`.

**Before making it public:**

1. Set a strong `CUBBY_ADMIN_TOKEN` and `CUBBY_REQUIRE_REVIEW=1`.
2. Add the hostname to the Cloudflare tunnel (the only step that makes it
   public; local DNS resolves it either way). Keep the node itself LAN/tailnet.
3. Put rate limits and a body-size limit at the edge as well as in the app.
4. Decide the moderation policy: what may be published, how fast reports are
   handled, how takedowns are recorded. Use the admin endpoints.
5. Back up `cubby-data` and test a restore.
6. Consider a separate VM/container for the store; it should never hold the
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
| demo sessions | 8 concurrent, 6/hour/IP, 15 min TTL, 100 objects/site, 20 s site timeout |

These are constants in `server.mjs`/`lib/bundle.mjs`; promote them to env vars
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
npm install --prefix cubby
npm test --prefix cubby         # manifest, bundle and API suites (node:test)
```

`cubby test/api.test.mjs` starts the real server on an ephemeral port with a
temporary data directory and exercises register → publish → catalog → download
→ yank → report → review/approve. No Docker or celld node is required.

End-to-end install (starts the store on an ephemeral port, publishes the demo
app through the real CLI, starts a throwaway `celld dev` node, installs it and
drives the app):

```sh
node cubby/test/e2e-install.mjs
```

It uses `TEST_INSTALL_PORT` (default 8780) for the node and never touches the
compose stack.

For the compose stack, `cubby install` uses `docker compose exec celld
/app/push.sh`; `CELLD_COMPOSE_DIR` points it at the pull-only production stack,
exactly like `tools/deploy.sh`.

The shelf e2e can be exercised by logging into the running instance and pressing
Install on the demo app; it deploys to `celld-<app>.<CUBBY_APP_DOMAIN>` and can be
removed again from the same screen. The CLI e2e (`cubby/test/e2e-install.mjs`)
covers the same installer path without a browser; `cubby/test/e2e-shelf.mjs`
runs the whole flow (publish → shelf login → install → open → remove) against a
throwaway store and `celld dev` node.

The store's UI is plain HTML/CSS/JS with no build step; `app.js` renders only
through `textContent` and never injects API strings as HTML.
