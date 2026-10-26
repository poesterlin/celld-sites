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
| `compose.yaml` | `s3` (VersityGW, files in a Docker volume), `celld` (the node) and `dashboard` |
| `node/` | celld node image: entrypoint (bucket setup, router deploy, node, bundled sites), `push.sh` and `admin.sh` |
| `router/` | The host-header router Worker and its config template |
| `tools/pack.mjs` | Packs a built site into a deploy bundle |
| `tools/deploy.sh` | Builds a site and deploys it to the running router |
| `tools/admin.sh` | Admin API from the host: aliases, rollback, pruning |
| `tools/preview.sh` | Local preview: the production router under `celld dev` with one site |
| `tools/seed.mjs` | Seed or export a site's Durable Objects through the admin API |
| `tests/` | API validation suite against a local node: `npm test --prefix tools` |
| `dashboard/` | Read-only dashboard (Bun, server-rendered, no JavaScript in the page) |
| `docs/SITES.md` | The site contract: build output, `celld.json`, bindings, migrations |
| `sites/AGENTS.md` | Instructions for agents building sites (contract, limits, workflow, checklist) |
| `sites/example/` | Test app: page views and a guestbook in Durable Objects, bundled into the image |
| `sites/sveltekit/`, `sites/nuxt/`, `sites/tanstack/` | Framework examples with Durable Objects, each with a `RECIPE.md` |
| `sites/static/` | A plain static site (no build, no server code), with a `RECIPE.md` |

## Run

```sh
cp .env.example .env    # fill in random values, chmod 600
docker compose up -d --build
```

The test app is served at `https://$HOST_DOMAIN` (set in `.env`). On every
start the `celld` container creates the bucket if it is missing, deploys the
router and starts the node, so a fresh or wiped bucket needs no manual steps.
The bundled example is deployed only if its site has no active version yet: a
restart never undoes a deploy or a rollback. To update the example after
changing it, deploy it like any site (`tools/deploy.sh sites/example $HOST_DOMAIN`).

## Dashboard

`https://$DASHBOARD_HOST` shows node health and memory, bucket disk usage by
area, every site with its deploy history, and each site's Durable Objects with
their disk usage and whether they are loaded. `/api/overview.json` returns the
same data as JSON. It has **no authentication**, so keep the hostname LAN-only.

It cannot change anything:

- It serves only `GET`/`HEAD` (other methods get 405) and has no write routes.
- It calls the router's admin API with `READ_TOKEN`, which only allows
  `GET /__admin/overview` and `GET /__admin/state`; deploying needs
  `ADMIN_TOKEN`. `/__admin/state` is the router fetching celld's `/state`, the
  only operator call it makes.
- Storage sizes come from the bucket volume mounted read-only; it holds no S3
  credentials. The container filesystem is read-only and runs as non-root.

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

The site is live as soon as the deploy returns, provided Traefik routes its
hostname to celld. `SITES_RULE` in `.env` is a pattern for all site hostnames
(e.g. ``'HostRegexp(`^celld-[a-z0-9-]+\.example\.com$`)'``, single-quoted so
the `$` survives), so names that match need no Traefik change and no restart.
A hostname outside the pattern has to be added to the rule
(``... || Host(`blog.other.com`)``), and changing the rule recreates the
`celld` container, which restarts every site. A deploy uploads each static file in its own
request (at most 20 MiB per file), then the server code and file list, then
activates the version; visitors switch only at that last step. Each version is
keyed by a hash of its content.

**4. Seed or export data.** Site code has no secrets, so it can't guard a seed
or import route itself. Instead, give the object methods for it (see `seed()`
and `export()` in `sites/sveltekit/src/objects.ts`) and call them through the
admin API:

```sh
node tools/seed.mjs blog.example.com sites/blog/seed.json            # production
node tools/seed.mjs --preview sites/blog sites/blog/seed.json         # local preview
node tools/seed.mjs blog.example.com --call Notes main export > notes.json
```

A calls file is a JSON array of `{ "class", "name", "method", "args" }`
(`sites/sveltekit/seed.json`). Copy production data into a preview by exporting
it and loading the result with the preview's seed method. Add `"version"` to a
call to target another version of the same site: one in its deploy history, or
one uploaded for it but not active yet (`PUT /code?version=V&host=H` records
that). Versions of other sites are refused. Seeding a staged version runs its
code against the live objects, so its migrations apply to production data
before the version is active.

**5. Operate.**

```sh
tools/admin.sh POST '/activate?host=blog.example.com&version=<id>'    # roll back (or forward)
tools/admin.sh PUT '/alias?host=new.example.com&site=blog.example.com' # serve a site under another name
tools/admin.sh DELETE '/alias?host=new.example.com'
tools/admin.sh POST '/prune?keep=3'   # keep each site's current version and its 3 most recent deploys
tools/admin.sh DELETE '/site?id=blog.example.com&confirm=blog.example.com'  # delete a site and all its data
```

Pruning also deletes versions that were uploaded but never activated, files
of uploads that never got a code record (after an hour), deploy history beyond
the last 100 entries per site, and index entries of deleted sites.

**Deleting a site** stops it serving at once, then deletes its Durable Objects'
data, its deploy history and staging records; it refuses while aliases point
at it unless `&aliases=delete` is added. There is no undo apart from the VM
backup, so export anything worth keeping first (`tools/seed.mjs --call`). Its
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
container creates it and redeploys the router and the example by itself.

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
- **Old site versions** stay until pruned (`tools/admin.sh POST '/prune?keep=3'`):
  roughly the size of the build (~0.5 MB for the example) per deploy.

## Tests

`npm test --prefix tools` (after `npm ci --prefix tools` once) validates the
APIs against a throwaway local `celld dev` node, never production: the admin
API (auth and the read/write split, upload limits, code checks, activation and
rollback, aliases, object calls, overview, pruning, deleting sites), routing (static-first,
clean URLs, HEAD, SPA and 404.html fallbacks, forwarded scheme), the site
bindings (`OBJECTS` validation, plain-data rule, errors, CPU limit; `ASSETS`;
blocked network) and the packer's refusals. 49 tests, about 8 s. Run it after
changing the router, the tools or the push/admin scripts.

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
  16 MiB for code), so a big deploy cannot exhaust the router's memory.
- `tools/pack.mjs` refuses symlinks in a site's static directory, so a link in
  a build folder cannot publish files from elsewhere on the machine.
- Sites are isolated from each other and from the router (separate isolates,
  only `ASSETS` and `OBJECTS`), and each request, including a Durable Object
  call, is capped at 1 s of CPU. The isolates share one process, so this is not
  a boundary against hostile code: fine for your own sites only.
- Sites have no outbound network (`globalOutbound: null`): `fetch()` throws.
  Otherwise site code could reach celld's unauthenticated operator API on
  127.0.0.1 (stop the node, evict objects, call other sites' objects); this
  was verified with a probe site. A site that needs an external API needs an
  explicit allowlist in the router.
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
Object adds ~1.4 MB to celld; it sheds objects at ~2.4 GB (80% of its 3 GB
limit), so ~1,500-2,000 objects can be resident at once.

These numbers predate serving static files straight from the router (without
the site's isolate) and need re-measuring. Each static file is still a KV read
per request, uncompressed and without an ETag; caching immutable files in the
router and adding validators and compression would help.

## Status

celld (v0.6.3) is alpha; Dynamic Workers and facets are beta at Cloudflare.
celld's ideas are being merged into Cloudflare's workerd, so expect a
migration at some point; sites are standard `adapter-cloudflare` builds.
