# celld-sites

Workers-style sites (SvelteKit, Nuxt, TanStack Start, plain static) served by
one [celld](https://github.com/denoland/celld) node (self-hosted Cloudflare
Workers + Durable Objects). Each site runs in its own
Dynamic Worker isolate, picked by the `Host` header, and can keep state in its
own Durable Objects (SQLite). Deploying a site is one command, with no restart.

```
browser → Traefik → celld (router Worker) → site isolate → its Durable Objects
                                   ↕
                          S3 bucket (VersityGW, on disk)
```

## Layout

| Path | What |
| --- | --- |
| `compose.yaml` | Development stack: `s3` (VersityGW, files in a Docker volume), `celld` (the node), `dashboard`, `hamstr` (profile `hamstr`), `tsidp` (profile `tsidp`), and `store` + `celld-demo` (profile `store`) |
| `node/` | celld node image: entrypoint (bucket setup, router deploy, node), `push.sh` and `admin.sh`; `Dockerfile` (target `hosting`) |
| `.github/workflows/images.yml` | CI: builds and publishes the hosting `celld` image and the dashboard image to GHCR |
| `.github/workflows/test.yml` | CI: unit suites, integration tests against `celld dev` (router API, the `hamstr` CLI from the repo and as a packed npm package, Hamstr end to end), the names service against Pebble, and the store, Hamstr and names image builds |
| `router/` | The host-header router Worker (`index.ts` plus modules by concern) and its config template |
| `tools/pack.ts` | Packs a built site into a deploy bundle |
| `tools/update.sh` | Updates a live site safely: dump its data, optionally rehearse on a copy site, deploy, drop the dump on success |
| `tools/deploy.sh` | Deploys a built site to the running router (`--build` builds it first) |
| `tools/deploy-emdash.sh` | Builds an EmDash (Astro) site for celld and deploys it, CMS editor included (see [EmDash sites](#emdash-sites)) |
| `adapters/emdash/` | Entry and Durable Objects that give an EmDash build its database, media and session bindings on celld |
| `tools/admin.sh` | Admin API from the host: aliases, egress allowlists, rollback, pruning |
| `tools/preview.sh` | Local preview: the production router under `celld dev` with one site |
| `tools/seed.ts` | Seed or export a site's Durable Objects through the admin API |
| `tools/restore-drill.sh` | Restore drill: a throwaway node on a copy of a bucket volume, checked against live |
| `tests/` | API validation suite against a local node: `npm test --prefix tools` |
| `dashboard/` | Read-only dashboard (Bun, server-rendered, no JavaScript in the page, Basic auth) with the bucket size scan |
| `store/` | Hamstr Store: the hosted app catalog, its web UI and the `hamstr` CLI; the store never runs or builds apps ([store/README.md](store/README.md)) |
| `packages/ui/` | Hamstr's design system: styles, icons and Svelte components shared by Hamstr and the Hamstr Store |
| `packages/app-format/` | The app format (`hamstr.json` manifests, packed bundles), validated the same way by the store, the CLI and Hamstr |
| `hamstr/` | Hamstr: a Sandstorm-style app shell: grains (one site per document), accounts (people, groups, invites, OIDC/GitHub/passkey sign-in) that also gate celld sites, identity headers for apps, revocable share links ([hamstr/README.md](hamstr/README.md)) |
| `names/` | Hamstr names: hostnames `<id>.<zone>` with a wildcard and DNS-01 for installs, so a Hamstr install needs no domain or DNS setup ([names/README.md](names/README.md)) |
| `docs/SITES.md` | The site contract: build output, `celld.json`, bindings, migrations |
| `docs/SECURITY.md` | Threat model: what a site can reach, what it can break, hostile-tenant checklist |
| `sites/AGENTS.md` | Instructions for agents building sites (contract, limits, workflow, checklist) |
| `sites/example/` | Test app: page views and a guestbook in Durable Objects, deployed with `tools/deploy.sh` like any site |
| `sites/sveltekit/`, `sites/nuxt/`, `sites/tanstack/` | Framework examples with Durable Objects, each with a `RECIPE.md` |
| `sites/static/` | A plain static site (no build, no server code), with a `RECIPE.md` |
| `sites/authdemo/` | Sign-in demo (SvelteKit, `"auth": "required"`): shows the `X-Celld-User-*` identity, an admins-only page and `/.celld/auth/me` |

## Run (development)

```sh
cp .env.example .env    # fill in random values, chmod 600
docker compose up -d --build
```

This builds the images locally. On every start the `celld` container creates
the bucket if it is missing, deploys the router and starts the node, so a fresh
or wiped bucket needs no manual steps. No site is bundled: deploy the test app
with `tools/deploy.sh sites/example $HOST_DOMAIN --build` (`HOST_DOMAIN` in
`.env` is the hostname the default `SITES_RULE` routes).

## Development vs hosting

The platform has two halves that share one codebase:

- **Development (this checkout).** Examples, recipes, tests, previews and the
  deploy tooling live here. `compose.yaml` builds the node image locally
  (`node/Dockerfile`).
- **Hosting (separate repo, `celld-sites-deploy`).** A pull-only compose file
  that runs the images CI publishes to GHCR and contains no examples or site
  sources. It pins `name: celld-sites`, the same project name as the dev stack,
  so switching between them keeps the volumes and all site data.

`.github/workflows/images.yml` builds and pushes:

| Image | Target | Notes |
| --- | --- | --- |
| `ghcr.io/poesterlin/celld-sites-node` | `node/Dockerfile` `hosting` | no bundled sites |
| `ghcr.io/poesterlin/celld-sites-dashboard` | `dashboard/Dockerfile` | dashboard |

Tags are `:latest` on `main`, `X.Y.Z`/`X.Y` on `v*` tags and `:main`; pull
requests build without pushing. Build a target by hand with
`docker build -f node/Dockerfile --target hosting .`.

The dev tooling reaches a hosting stack through `CELLD_COMPOSE_DIR`, without
copying anything into it:

```sh
CELLD_COMPOSE_DIR=~/projects/services/celld-sites-deploy \
  tools/deploy.sh sites/wichtel wichteln.example.com
CELLD_COMPOSE_DIR=~/projects/services/celld-sites-deploy tools/admin.sh GET /overview
```

The hosting repo's README covers first start, migration, upgrades and GHCR
access. Live sites (including `sites/wichtel/`) are gitignored: they are built
and pushed with `tools/deploy.sh` from their own checkouts and are not part of
the platform source.

## Dashboard

`https://$DASHBOARD_HOST` shows node health and memory, bucket disk usage by
area, every site with its deploy history, and each site's Durable Objects with
their disk usage and whether they are loaded. `/api/overview.json` returns the
same data as JSON. It sits behind HTTP Basic auth (user `admin` or
`DASHBOARD_USER`, password `DASHBOARD_PASSWORD` from `.env`, required to start
and at least 12 characters), and the hostname stays LAN-only. `/health`, for the
container healthcheck, is the only open route.

It cannot change anything:

- It serves only `GET`/`HEAD` (other methods get 405) and has no write routes.
- It calls the router's admin API with `READ_TOKEN`, which only allows
  `GET /__admin/overview` and `GET /__admin/state`; deploying needs
  `ADMIN_TOKEN`. `/__admin/state` is the router fetching celld's `/state`, the
  only operator call it makes.
- It mounts the bucket read-only (`BUCKET_DIR`), which holds every site's code
  and Durable Object data, to measure storage sizes. It reports sizes and never
  reads file contents, but a bug in it could, which is why it needs the login. A
  worker thread rescans every 60 s (`src/bucket-worker.ts`), so sizes can be up
  to a minute old. The container has a read-only filesystem and runs as non-root.

Object names only exist as hashes in storage, so the router keeps an index
(`obj:` keys in KV) written the first time each object is used. Objects created
before the index existed show up as "not in the index" with their total size.

## Workflow: develop, preview, deploy, seed

The platform holds only production versions. Previews run on your machine.

Any build that is a Workers `fetch` handler plus static files works (SvelteKit,
Nuxt, TanStack Start, static-only); see `docs/SITES.md`, `sites/AGENTS.md` (for
agents building sites) and the examples in `sites/` (each has a `RECIPE.md`).

**1. Develop.** Use the framework's own dev server (`npm run dev`) for UI work
with hot reload. It does not provide the `OBJECTS` binding (only the router
does), so anything that touches Durable Objects needs a preview.

**2. Preview locally**, running exactly as in production: the production router
under `celld dev` on your machine, with the site deployed into it (same
isolation, bindings and runtime patches). Local data persists in
`<site>/.celld-preview/` (gitignored).

```sh
tools/preview.sh sites/blog            # build and deploy; http://localhost:8790/ (any hostname)
tools/preview.sh sites/blog            # again after an edit (~5 s)
tools/preview.sh sites/blog --stop     # or --reset to delete the local data
```

`PREVIEW_HOST=0.0.0.0` makes it reachable from other machines. The node log is
`<site>/.celld-preview/celld.log`.

**3. Deploy to production.**

```sh
tools/deploy.sh sites/blog blog.example.com
```

To update a site that already holds data, use `tools/update.sh` instead: it
dumps the site first (`backups/<host>-<time>.backup`, override with
`CELLD_BACKUP_DIR`; `--no-dump` skips it), deploys, and deletes the dump once
the deploy and its watch pass. A failed deploy keeps the dump and prints the
restore command. `--rehearse blog-copy.example.com` first deploys the new
version to a separate site, restores the dump into it (so the version's
migrations run on real data) and requests `/`; the copy's data is replaced, and
the live site is untouched if that fails. The copy hostname must match
`SITES_RULE` to be reachable, but the rehearsal talks to the node directly.

If production runs the separate pull-only stack (the normal setup here), prefix
the command with `CELLD_COMPOSE_DIR=~/projects/services/celld-sites-deploy` so
the build and check target that stack instead of this checkout; without it the
deploy goes to the local development stack. The same applies to `admin.sh`,
`seed.ts`, `deploy-emdash.sh` and `restore-drill.sh`.

Before activating, the deploy **checks** the new version: the router runs it
without activating it, with its Durable Objects in an empty scratch namespace
(so its migrations run on fresh databases; deleted afterwards), and requests
its check path (`"check"` in `celld.json`, default `/`). A 5xx, an error at
load or a timeout stops the deploy and the old version stays live. After
activating, it **watches** the live site for 10 s, probing the check path every
2 s; a 5xx there (e.g. a migration that fails on real data) activates the
previous version again and fails the deploy. Code is rolled back, data is not:
whatever the new version already changed stays changed. `--watch SECS` changes
the window, `--no-check` skips both, `"check": false` turns them off for a site.

The site is live as soon as the deploy returns, provided Traefik routes its
hostname to celld. `SITES_RULE` in `.env` is a pattern for all site hostnames
(e.g. ``'HostRegexp(`^celld-[a-z0-9-]+\.example\.com$`) && !Host(`celld-admin.example.com`)'``,
single-quoted so the `$` survives; the `!Host()` keeps the dashboard host out of
the pattern), so names that match need no Traefik change and no restart.
A hostname outside the pattern has to be added to the rule
(``... || Host(`blog.other.com`)``), and changing the rule recreates the
`celld` container, which restarts every site.

Files are stored once by content hash (SHA-256) and shared by every version and
site that has them. A deploy asks the router which of its files are missing,
uploads only those (6 at a time, at most 20 MiB per file, each checked against
its hash), then the server code and file list, then activates the version;
visitors switch only at that last step. Each version is keyed by a hash of its
content. Versions uploaded before this (files under `asset:<version>:` keys)
keep working until pruned; re-deploying the same content moves them to the
shared store.

**4. Seed or export data.** Site code has no secrets, so it can't guard a seed
or import route itself. Instead, give the object methods for it (see `seed()`
and `export()` in `sites/sveltekit/src/objects.ts`) and call them through the
admin API:

```sh
node tools/seed.ts blog.example.com sites/blog/seed.json            # production
node tools/seed.ts --preview sites/blog sites/blog/seed.json         # local preview
node tools/seed.ts blog.example.com --call Notes main export > notes.json
```

**Back up and restore** a whole site's objects without any methods of your
own: the router can read and rewrite every object's storage (its SQLite tables,
schema and rows, and its key-value pairs).

```sh
tools/admin.sh GET '/dump?host=blog.example.com' > blog.backup            # JSON lines
tools/admin.sh POST '/restore?host=blog.example.com&confirm=blog.example.com' - < blog.backup
```

A dump streams one object after another: its tables (schema, then rows in
pages of about 1 MB), its key-value pairs, then its indexes, triggers and
views, and an `end` line with totals; a dump without that line is incomplete
and restore refuses it. Values JSON can't say (bytes, dates, maps, big
integers...) are tagged objects. Virtual tables (FTS5) are dumped through their
rows, not their shadow tables, and rebuild on restore; generated columns are
recomputed. Restore empties each object in the backup and refills it, deletes
indexed objects the backup does not have, then restarts the objects, so the
live version's constructors (and migrations) run on the restored data; a
backup from an older version of the site is migrated that way. It runs the
site's live version and does not pause the site: stop its traffic first. A
restore that fails half-way answers `changed: true`; restore a good backup to
recover. The same backup restores into another site of the same code (a copy).
How it works: the router adds a reserved `__celldData` method to every class a
site exports; site code cannot call it through `OBJECTS` (any `__celld*`
method is refused there and in `/call`).

A calls file is a JSON array of `{ "class", "name", "method", "args" }`
(`sites/sveltekit/seed.json`). Copy production data into a preview by exporting
it and loading the result with the preview's seed method. Add `"version"` to a
call to seed a site that is not live yet with a version uploaded for it but not
activated (`PUT /code?version=V&host=H` records that), then activate it. A live
site's objects only ever run its active version: any other version would run
its code and migrations on the data the live version is using, so the router
refuses it (409).

**5. Operate.**

```sh
tools/admin.sh POST '/activate?host=blog.example.com&version=<id>'    # roll back (or forward)
tools/admin.sh PUT '/alias?host=new.example.com&site=blog.example.com' # serve a site under another name
tools/admin.sh DELETE '/alias?host=new.example.com'
tools/admin.sh POST '/prune?keep=3&confirm=prune'   # keep each site's current version and its 3 most recent deploys
tools/admin.sh DELETE '/site?id=blog.example.com&confirm=blog.example.com'  # delete a site and all its data
printf '["api.example.com"]\n' | tools/admin.sh PUT '/egress?host=blog.example.com' -  # let a site fetch these hosts
tools/admin.sh GET '/egress?host=blog.example.com'
tools/admin.sh DELETE '/egress?host=blog.example.com'  # back to no outbound network: aborts the site's live objects
```

Deploy and activation endpoints take a **site id, not an alias** (an alias is
refused with 409, so a deploy cannot silently change the site it points at).
Changing an egress list aborts every indexed object of that site, so pending
timers cannot keep using the old list.

Pruning also deletes versions that were uploaded but never activated, files
of uploads that never got a code record (after an hour), deploy history beyond
the last 100 entries per site, and index entries of deleted sites.

**Deleting a site** stops it serving at once, then deletes its Durable Objects'
data, its deploy history and staging records; it refuses while aliases point
at it unless `&aliases=delete` is added. There is no undo apart from the VM
backup, so back it up first (`/__admin/dump`, above). Its
versions go with the next prune. Deploying to the same id later starts a new,
empty site. Objects created before the object index existed can't be found by
name and are not deleted (the dashboard counts them as "not in the index").

**Site ids.** A site's id is the hostname it was first deployed to, and the id
owns its versions and Durable Objects. To rename a site, alias the new hostname
to it; deploying to a new hostname instead creates a new, empty site. The
dashboard shows each site's id, hostnames and deploy history.

SvelteKit sites should set `version: { name: <git commit> }` (see
`sites/example/vite.config.ts`): the default is a build timestamp, which makes
every rebuild a new version even with no changes.

## Hamstr Store (prototype)

`store/` is the hosted catalog for the "little tools" that are too small for
Docker: publishers upload a packed celld bundle with `hamstr publish`; people
press **Get** in their own Hamstr (developers can run `hamstr install <app>
--host <their-host>`), and the app runs on their node with its data in local
SQLite. The store is not part of a personal Hamstr: one store serves many
Hamstrs, which point `HAMSTR_STORE` at it. The store holds metadata and bytes only; it has
no route to the celld admin API or the bucket and never executes published
code. Egress is the only permission an app can request, and the installer asks
before granting it.

This compose file runs the store for the host that operates it, behind the
`store` profile (`STORE_HOST`, `STORE_ADMIN_TOKEN`, `STORE_REQUIRE_REVIEW`).
App entries also have **Try it**, which deploys the release to the disposable
`celld-demo` node, iframes it for `STORE_DEMO_TTL_SECS` (default 15 min) and
deletes it; that node has its own bucket/token, no egress and session limits.
Making the catalog public is a Cloudflare tunnel entry plus
`STORE_REQUIRE_REVIEW=1`; public demos additionally need wildcard `demo-*`
DNS/tunnel. The store's UI and Hamstr's look the same: both are built from
`packages/ui`. See [store/README.md](store/README.md) for the architecture,
threat model, API and deployment checklist.

## Hamstr

`hamstr/` turns the node into a small Sandstorm: people sign in with tsidp,
install apps from the Hamstr Store, and make **grains** (a board, a list, a
draw), each its own site at `grain-<id>.<domain>` with its own data. Hamstr
proxies every grain request, so apps get the visitor's identity and
permissions as `X-Hamstr-*` headers and never implement login. The router serves
`grain-*` sites only to Hamstr (`PROXY_TOKEN`). It is a compose profile
(`COMPOSE_PROFILES=hamstr`) and LAN-only. See [hamstr/README.md](hamstr/README.md).

## EmDash sites

An [EmDash](https://github.com/emdash-cms/emdash) site (Astro +
`@astrojs/cloudflare`, e.g. a checkout of the EmDash starter kit) runs here
with its CMS editor at `https://<host>/_emdash/admin`:

```sh
(cd ../emdash-site && bun install)
tools/deploy-emdash.sh ../emdash-site blog.example.com
```

The script builds the site's own `astro.config.mjs` with one change, the
database: EmDash's Durable Object adapter (`durableObjects()`) instead of D1.
`adapters/emdash/` supplies what the build expects from Cloudflare on top of
`OBJECTS`: the `DB_DO` namespace (class `EmDashDB`, one SQLite database for the
whole CMS), an R2-style `MEDIA` bucket for uploads (`EmDashMedia`, files in
512 KiB rows) and the `SESSION` KV namespace for logins (`EmDashKV`). It hides
celld's internal `_litestream_*` tables from EmDash's schema introspection;
reading their schema is not authorized, which is what made every migration
fail before.

On a site's first deploy the script applies the site's seed (setup step 1,
with content). Whoever then opens `/_emdash/admin` first registers the admin
with a passkey, bound to that hostname; until then anyone who can reach the
hostname can claim it. Later deploys change code only: content edited in the
CMS stays. Not available here: email (EmDash's email plugin and magic links),
EmDash's cron jobs (scheduled publishing) and the Cloudflare Images binding.

celld 0.6.3 never settles an outbound call made from a promise continuation
that another request's event resumed (denoland/celld#258, #277). Two places
hit that: concurrent first requests waiting on a site load another request had
started (the router now reads the code itself and loads synchronously; test
"cold start under concurrency"), and EmDash sharing in-flight promises between
requests, which made its admin's ~15 parallel API calls hang until the 504.
The adapter therefore runs one request at a time per isolate (a 15-call admin
burst takes 0.2-1 s).

Each EmDash site is ~8 MB of minified server code and ~120 MB of node memory
once loaded (loaded sites stay resident), hence `CELLD_MEM_LIMIT` (default
`8g`). The first request after a deploy runs EmDash's migrations (~7 s).

The router keeps recent code records in memory, so a warm request costs no
multi-MB bucket read. That cache is bounded by bytes (24 MiB); bounded by
entries (64) instead, the records of the 72 deployed versions (the EmDash ones
~8 MB each) filled the whole of the router isolate's V8 heap: it measured 132
MB against the default limit of 128 MB (`CELLD_V8_HEAP_LIMIT_MB`), and an
isolate over its limit stops materializing SQL result sets. Every admin API
read that lists keys then answered 500 ("the isolate is over its V8 heap
limit"), which also made deploys fail, until a restart. The router's heap now
stays around 50 MB while deploying.

EmDash builds a content URL from its collection's `urlPattern` and falls back
to `/<collection>/<slug>`, so with no pattern set its admin linked pages to
`/pages/<slug>` while they render at `/<slug>` (the sitemap and menus used the
same fallback). Two fixes: `tools/deploy-emdash.sh` adds
`"urlPattern": "/{slug}"` to every collection in the seed that lacks one (for a
site's first deploy; the checkout copy is restored after the build), and the
adapter fills the pattern into `/_emdash/api/manifest` from the collection row,
because emdash 0.36 never sends it there — the field is missing from its
`ManifestResponse`, and the admin therefore always took the fallback. emdash
0.37 added it, so the adapter's patch can go when the starter upgrades.

## Durable Objects

Export classes from `src/objects.ts` and call them from routes:

```ts
await env.OBJECTS.call('Guestbook', 'main', 'add', name, message);
```

Each `(site, class, name)` is a separate object with its own SQLite database.
The router runs it as a facet of its `SiteObject`, keyed by the site id, so a
site can only reach its own objects. Data survives redeploys and aliases.
See `sites/example/src/objects.ts`.

Limits: arguments and results must be plain (structured-cloneable) data, so
calls are RPC methods, not `fetch`; objects cannot set alarms; WebSockets in an
object do not hibernate.

## Storage

The bucket is VersityGW's posix backend: every object is a plain file in the
`celld-sites_s3-data` Docker volume, so the daily VM backup covers it. celld's
local working copy is in `celld-sites_celld-state`; the bucket is the source of
truth and celld rebuilds that copy from it. Data survives container restarts,
`docker compose down` and image updates (not `down -v`, which deletes volumes).

`S3_FSYNC` (default `true`) makes VersityGW flush each object to disk before it
acknowledges it. celld confirms a write only once the bucket has it, so with
fsync a confirmed write survives a VM crash or power loss. Set `S3_FSYNC=false`
for more write throughput; then a VM crash (not a container restart) can lose
the last seconds of confirmed writes. Measured costs are below.

If the bucket is ever empty (first start, or a deleted volume), the `celld`
container creates it and redeploys the router by itself.

**Restore drill.** `tools/restore-drill.sh` proves a bucket volume alone brings
every site back: it copies the volume into a throwaway one, starts a throwaway
VersityGW and node on it (default bridge, no ports), checks that every site
answers below 500 and that sites, objects and versions match the live node, and
removes everything. `--calls FILE` also compares read-only object methods
between live and drill (e.g. `[{"host": "...", "class": "Notes", "name":
"main", "method": "export"}]`). To drill a VM backup, restore the volume under
another name and pass it. Copying the live volume isn't an atomic snapshot;
`--pause` pauses the live `s3` container during the copy (writes stall for
those seconds). Last run (2026-10-26, live volume): 202 MB, 4 sites, 12
objects, all served; one compared export identical; 14 s.

### What grows

- **Durable Object logs.** celld keeps a write log per object in the bucket,
  about 4-6 KB per write transaction (whole SQLite pages). Compaction adds
  summary objects but deletes nothing, and celld 0.6.3 never cleans up facet
  logs, which is where all site objects live: ~1 GB per ~200,000 writes. Watch
  the volume size if a site writes a lot.
- **The router's own storage** (KV with site code and assets, root objects) is
  cleaned up: `CELLD_LTX_RETENTION_SECS` (default 3600) deletes write-log
  epochs older than an hour that no restore needs. A new epoch starts when an
  object is restored, e.g. after a celld restart.
- **Old site versions** stay until pruned (`tools/admin.sh POST '/prune?keep=3&confirm=prune'`):
  each costs its server code plus the files that changed since earlier
  versions. Prune deletes the files no remaining version uses.

## Tests

`npm test --prefix tools` (after `npm ci --prefix tools` once) validates the
APIs against a throwaway local `celld dev` node, never production: the admin
API (auth and the read/write split, upload limits and hash checks, code checks,
activation and rollback, deploy checks and post-activation rollback, aliases,
object calls, overview, pruning, deleting sites), routing (static-first, clean
URLs, HEAD, SPA and 404.html fallbacks, forwarded scheme), the site bindings
(`OBJECTS` validation, plain-data rule, errors, CPU and wall-clock limits;
`ASSETS`; blocked network, and the egress allowlist), static-file validators
and caching, and the packer's refusals and defaults, and upgrading from
per-version files. `tests/security.test.ts` adds the request-context surface,
admin-host isolation, path traversal, the atomic object quota and the in-flight
cap; backups (dump, restore, copies, broken backups) run against a fixture
class with foreign keys, blobs, FTS5, a trigger and typed key-value pairs.
102 tests, about a minute. Run it after changing the router, the tools or the
push/admin scripts.

The image pins `ghcr.io/denoland/celld:v0.6.3`. To judge a new release, put
its `celld` binary on `PATH` and run the suite: it runs the real router under
`celld dev`, so it exercises the loader, the facet and SQLite APIs, service
bindings, `globalOutbound` and the admin API the platform depends on. Then
rebuild the node image and check the examples.

## Typechecking

The source is TypeScript; every package has a `tsconfig.json` and
`npm run typecheck` at the repo root checks all of them (`tsc` and the shared
types are root devDependencies, resolved upward, and `types/celld.d.ts` is the
small `cloudflare:workers` surface the router, adapters and fixtures rely on).
The configs are deliberately non-strict: the code is JavaScript that grew a
`.ts` extension, so `strict`, `noImplicitAny` and `strictNullChecks` are off
until each file is annotated. Node runs `.ts` directly (type stripping, Node
24+), which is why no build step is involved; the CLI is the exception and
still ships compiled `.mjs` because it targets Node 20.

## Security

- celld's internal operator listener (unauthenticated) stays on 127.0.0.1
  inside the container; the bucket is only on the project network.
- The admin API answers only for the hostname `admin.internal`, which Traefik
  never routes. Writes need `ADMIN_TOKEN`; the dashboard's `READ_TOKEN` only
  allows the two read endpoints. The router gets only SHA-256 hashes of both
  tokens, so the bucket (which stores deployments, and which the dashboard can
  read) never holds a usable token. `tools/deploy.sh` and `tools/admin.sh`
  reach the API with `docker compose exec`.
- Uploads are size-checked before they are read (413 above 20 MiB per file,
  16 MiB for code), so a big deploy cannot exhaust the router's memory. A file
  is stored only if its bytes match the hash it is uploaded under, so no upload
  can change a file that other versions use.
- `tools/pack.ts` refuses symlinks in a site's static directory, so a link in
  a build folder cannot publish files from elsewhere on the machine.
- Sites are isolated from each other and from the router (separate isolates,
  only `ASSETS` and `OBJECTS`), and each request, including a Durable Object
  call, is capped at 1 s of CPU. A response that takes longer than
  `SITE_TIMEOUT_SECS` (default 30) of wall-clock time to start gets a 504, and
  an object call gives up after 80% of that, so code that waits forever can't
  hold connections open. The isolates share one process, so this is not
  a boundary against hostile code: fine for your own sites only. See
  `docs/SECURITY.md` for the full threat model and the hostile-tenant checklist.
- Per-site limits make one flooded or runaway site fail on its own instead of
  starving the node: 128 concurrent requests per site (503 above,
  `SITE_MAX_INFLIGHT`), 1000 subrequests per request (`SITE_MAX_SUBREQUESTS`),
  and 1000 Durable Objects per site (`SITE_MAX_OBJECTS`). The object cap is
  checked when an object is created and bounds the SQLite databases and write
  logs a site can add; bytes are not quota'd, so watch bucket growth.
- Site code gets a minimal request context (`waitUntil`, `abort`,
  `passThroughOnException`); `ctx.exports` and `ctx.props` are dropped, so the
  router's own exports are not reachable from a site even if celld grows that
  API. Deploy paths with `..` segments or backslashes are refused, and request
  paths containing them answer 404 without a lookup.
- Deploy invariants: a version id is immutable (re-uploading the same record is
  a no-op, different content is a 409), and `activate`/`check` refuse a version
  that was not uploaded for that site (staged with `PUT /code?host=` or
  `POST /stage`, or in its deploy history), so a bundle built for one site
  cannot run with another site's Durable Objects. Deploy endpoints refuse an
  alias hostname, and at most 20 versions may be staged per site. `prune` needs
  `confirm=prune` and whole-number `keep`/`orphanAge`/`stagedAge`; it keeps
  versions staged for a deploy younger than `stagedAge` (default an hour) so an
  in-flight deploy is not deleted. `admin.internal` is not a valid site id.
- Sites have no outbound network unless the operator allowlists hostnames for
  that site (`PUT /__admin/egress?host=…`, a JSON array). Without a list
  (`globalOutbound: null`) `fetch()` throws; with one, `fetch()` reaches exactly
  those hosts, over HTTPS on 443 only, and gets a 403 for anything else. The proxy refuses IP literals
  and internal names, does not follow redirects (the site follows them, so
  each hop is checked), and cannot broker `connect()` or WebSockets. This keeps
  site code away from celld's unauthenticated operator API on 127.0.0.1 (stop
  the node, evict objects, call other sites' objects), which was verified with
  a probe site. Only allowlist names whose DNS you control: a name that
  resolves to a private address (DNS rebinding) is not caught by a name check.
  HTTPS-on-443-only limits the damage: a rebound name cannot reach the
  operator API, which speaks plain HTTP on another port. A changed list
  applies within a minute (each router isolate caches it).
- Both containers drop all capabilities; celld runs as uid 10001.

## Measured (this VM)

Single requests through Traefik, bucket on disk:

| | `S3_FSYNC=true` (default) | `S3_FSYNC=false` |
| --- | --- | --- |
| Page render with 2 Durable Object calls (1 write), p50 / p99 | 14.9 / 29.4 ms | 11.2 / 27.8 ms |
| Durable Object write via `/api/hit`, p50 / p99 | 14.1 / 18.7 ms | 10.6 / 22.3 ms |
| Static asset, p50 / p99 | 3.8 / 5.9 ms | same |

Throughput (10 s, 50 connections, load generator on the same VM; celld is
CPU-bound at ~6 of 10 cores for reads):

| Through Traefik (HTTPS) | `S3_FSYNC=true` | `S3_FSYNC=false` |
| --- | --- | --- |
| Page without Durable Objects | ~2,950 req/s | same |
| Static asset | ~2,020 req/s | same |
| Home page (2 object calls, 1 shared write) | 582 req/s | 641 req/s |
| Durable Object writes spread over 1,000 objects | 292 req/s | 785 req/s |

Writes to many different objects pay one disk flush each, which is where fsync
costs most. Reads and pages without writes don't touch the bucket's disk.

Memory: ~100 MB celld and ~25 MB VersityGW at rest. Each resident Durable
Object adds ~1.4 MB to celld and each loaded EmDash site ~120 MB; it sheds
objects at ~6.4 GB (80% of its 8 GB limit, `CELLD_MEM_LIMIT`), so ~4,500
objects can be resident at once.

Static files (2026-10-26). The router serves them without starting the site's
isolate, keeps up to 32 MiB of files (each up to 1 MiB) in memory, sends an
ETag (`"<version>:<path>"`) and answers `If-None-Match` with 304; Traefik
compresses text types. Router alone, `celld dev`, 50 connections, VM load
average ~16:

| | Before (KV read per request) | Memory cache |
| --- | --- | --- |
| 18-byte file | ~2,750 req/s | ~4,200 req/s |
| 80 KB file | ~1,290 req/s | ~3,500 req/s |

Through Traefik (HTTPS) the same build measured ~1,000 req/s for a small
SvelteKit chunk and ~920 req/s (identity) / ~690 req/s (gzip) for a 76 KB Nuxt
chunk; TLS and compression in Traefik are the limit there. The page and
Durable Object numbers above are older.

## Status

celld (v0.6.3) is alpha; Dynamic Workers and facets are beta at Cloudflare.
celld's ideas are being merged into Cloudflare's workerd, so expect a
migration at some point; sites are standard `adapter-cloudflare` builds.

## License

[MIT](LICENSE).
