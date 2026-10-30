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
and the installer path. It was called Cubby before; old `cubby.json` manifests,
`~/.config/cubby` CLI configs and `#/app/<slug>` links still work.

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
  not belong in the store yet.

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
   pack.mjs + tar.gz  ──────▶  POST /apps/:slug/releases (manifest)
                              PUT  /releases/:id/bundle (tar.gz)
                                validate tar: paths, types, sizes,
                                blob hashes, code.json, limits
                                store blobs/<sha256>.tgz
                                SQLite: publishers, apps, releases
   ◀────────────────────────  catalog JSON / download URL
                                                                    Get in Hamstr, or
                                                                    hamstr install app --host h
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
| `server.mjs` | store container | HTTP API, serves the web UI, SQLite, blob files |
| `web/` | store container | the web UI: a SvelteKit single-page app built on `packages/ui` (the same components as Hamstr's own store pages) |
| `../packages/app-format/manifest.mjs` | store, CLI, Hamstr | `hamstr.json` schema and egress host rules |
| `../packages/app-format/bundle.mjs` | store, CLI, Hamstr | tar.gz validation: safe paths, regular files only, size caps, blob hash equality, `code.json` cross-check |
| `cli/` | publisher/developer machine | the `hamstr` CLI (npm package `@hamstr/cli`, see [cli/README.md](cli/README.md)): register/login, publish (build + pack + upload), install into a celld node over its admin API or a compose stack, update/list/report. Needs no checkout of this repo |
| `celld-demo` (compose) | separate node | disposable per-session copies for "Try it"; own bucket/token, no egress |
| `examples/` | repo | demo apps: `secret-santa` (one worker, one Durable Object) and `pinboard` (a Hamstr grain app) |

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
- Sessions are capped (`STORE_DEMO_MAX`, default 8 concurrent), rate-limited per
  IP (`STORE_DEMO_PER_HOUR`, default 6), and expire after `STORE_DEMO_TTL_SECS`
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

`status` is `uploading → pending → published`, then `yanked` (withdrawn: hidden,
downloads answer 410) or `removed` (deleted by its publisher or taken down by
an operator: files deleted, downloads answer 404). A removed release keeps its
row and hashes, so its version is never free again.
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
catalog is meaningful. The manifest (`hamstr.json`) is separate metadata and is
never placed inside the deployable bundle; an installer cannot be tricked by a
second copy of the metadata inside the archive.

### Publishing flow

1. `hamstr publish ./app` reads `hamstr.json`, runs the site build (unless
   `--no-build`), runs `tools/pack.mjs`, creates a deterministic tar.gz and
   validates it with the same library the store uses.
2. `POST /api/v1/apps/:slug/releases` sends the manifest. The store validates
   it, checks ownership and quotas, and returns an upload URL.
3. `PUT .../bundle` streams the tar.gz (Content-Length required, bounded),
   hashes it, validates the archive, stores it by hash, and marks the release
   `published` (or `pending` in review mode).
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

Public reads, token-authenticated writes. Tokens are `cub_<id>_<secret>` (the
prefix is from the store's old name and kept so existing tokens stay valid);
only the SHA-256 of the secret is stored, and publishers are looked up by token
id.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | – | liveness and counts |
| GET | `/api/v1/apps?q=&tag=&limit=&offset=` | – | catalog search |
| GET | `/api/v1/apps/:slug` | – | app + published releases (owner token also sees pending) |
| GET | `/api/v1/apps/:slug/releases/:version/download` | – | bundle, `X-Bundle-Sha256` |
| GET | `/api/v1/apps/:slug/releases/:version/source` | – | optional source archive |
| POST | `/api/v1/publishers` | – | create publisher, returns token once |
| POST | `/api/v1/tokens` | – | password login, new token |
| DELETE | `/api/v1/tokens` | token | revoke all tokens |
| GET | `/api/v1/me` | token | own apps incl. pending releases |
| POST | `/api/v1/apps/:slug/releases` | token | create release metadata |
| PUT | `/api/v1/releases/:id/bundle` | token | upload tar.gz |
| PUT | `/api/v1/releases/:id/source` | token | optional source tar.gz |
| POST | `/api/v1/releases/:id/yank` | token | withdraw a release |
| DELETE | `/api/v1/releases/:id` | token | remove a release (files deleted, version stays taken) |
| DELETE | `/api/v1/apps/:slug` | token | remove an app from the catalog: every release removed, name kept for its publisher |
| POST | `/api/v1/apps/:slug/releases/:version/report` | – | abuse report (rate-limited) |
| POST | `/api/v1/apps/:slug/demo` | – | start a throwaway demo session |
| GET | `/api/v1/demos/:id` | – | demo status, URL and expiry |
| DELETE | `/api/v1/demos/:id` | – | end a demo early |
| GET | `/api/v1/admin/pending` | admin | review queue |
| GET | `/api/v1/admin/reports` | admin | open reports |
| POST | `/api/v1/admin/releases/:id/approve` | admin | publish a pending release |
| DELETE | `/api/v1/admin/releases/:id` | admin | takedown (as a removal: the version stays taken) |
| POST | `/api/v1/admin/reports/:id/resolve` | admin | close a report |

`STORE_ADMIN_TOKEN` enables the admin routes; without it they answer 503.
Publishing is rate-limited per publisher; registration, login, reports and
downloads per IP. Limits are in-memory for the prototype and reset on restart.

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
- **Demo compromise** is the demo node only: separate bucket, state and admin
  token, no production credentials. The demo node still executes untrusted app
  code in the celld sandbox, so keep it resource-capped and ephemeral; a demo
  session is not a place for real data.
- **Publisher compromise** can publish a new version under that publisher's
  apps and yank them; it cannot activate anything on users' nodes.
- **Malicious bundle**: never executed by the store; the installer validates
  structure and hashes, but the *code is untrusted*. The celld isolate, CPU
  limit and egress allowlist are the real boundary. This is why install shows
  requested hosts and why `STORE_REQUIRE_REVIEW=1` matters for a public store.
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

## 5. Hosting the store and going public

A personal Hamstr does not run a store; it points `HAMSTR_STORE` at one. The
root `compose.yaml` includes the store (and its demo node) for the host that
operates it, behind the `store` compose profile:

```sh
# .env
COMPOSE_PROFILES=hamstr,store
STORE_HOST=store.example.com
STORE_ADMIN_TOKEN=<openssl rand -base64 24>
STORE_REQUIRE_REVIEW=0   # 1 for a public store
DEMO_ADMIN_TOKEN=<openssl rand -hex 24>   # hex: the celld entrypoint allows [A-Za-z0-9_-]
DEMO_READ_TOKEN=<openssl rand -hex 24>
STORE_DEMO_DOMAIN=example.com

docker compose up -d --build store celld-demo
open https://store.example.com
```

The image is `store/Dockerfile` (build context: the repo root); it builds the
web UI and ships it with the server. Data lives in the store's volume (still
named `celld-sites_cubby-data` from the old name: `cubby.db` + `blobs/`); back
it up like any other service. The container is read-only except that volume,
runs as the `node` user, drops all capabilities and joins only `traefik_web`.

**Before making it public:**

1. Set a strong `STORE_ADMIN_TOKEN` and `STORE_REQUIRE_REVIEW=1`.
2. Add the hostname to the Cloudflare tunnel (the only step that makes it
   public; local DNS resolves it either way). Keep the node itself LAN/tailnet.
3. Put rate limits and a body-size limit at the edge as well as in the app.
4. Decide the moderation policy: what may be published, how fast reports are
   handled, how takedowns are recorded. Use the admin endpoints.
5. Back up the store volume and test a restore.
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

These are constants in `server.mjs`/`../packages/app-format/bundle.mjs`; promote them to env vars
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
npm install --prefix packages/app-format
npm install --prefix store
npm test --prefix store          # manifest, bundle, API and web-serving suites (node:test)
```

`store/test/api.test.mjs` starts the real server on an ephemeral port with a
temporary data directory and exercises register → publish → catalog → download
→ yank → report → review/approve. No Docker or celld node is required.

The web UI:

```sh
npm install --prefix store/web
npm run build --prefix store/web       # → store/web/build, served by server.mjs
# or, while working on it, with the API from `node store/server.mjs` on :3000:
npm run dev --prefix store/web
```

It is a single-page app (`ssr = false`): `server.mjs` serves the build and
answers every page path with `index.html`, whose one inline bootstrap script the
CSP allows by hash. Text from the API is rendered by Svelte (escaped); links use
only http(s) values the server validated.

End-to-end install (starts the store on an ephemeral port, publishes the demo
app through the real CLI, starts a throwaway `celld dev` node, installs it and
drives the app):

```sh
node store/test/e2e-install.mjs
```

It uses `TEST_INSTALL_PORT` (default 8780) for the node and never touches the
compose stack. The same flow with the CLI as outside developers get it (packed
with `npm pack`, installed into an empty directory, run without this repo, the
node saved with `hamstr node`):

```sh
node store/test/e2e-cli-package.mjs     # TEST_CLI_PORT, default 8781
```

With a compose stack instead of a node URL, `hamstr install --compose-dir <dir>`
uses `docker compose exec celld /app/push.sh` there, like `tools/deploy.sh`.

CI (`.github/workflows/test.yml`) runs the unit suites, the router API suite,
both CLI end-to-end tests, Hamstr's end-to-end test (each against `celld dev`,
the binary copied out of the celld image the node uses), the names service
against Pebble, and builds the store, Hamstr and names images.
