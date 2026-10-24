# celld-sites

SvelteKit sites served by one [celld](https://github.com/denoland/celld) node
(self-hosted Cloudflare Workers + Durable Objects). Each site runs in its own
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
| `compose.yaml` | `s3` (VersityGW, files in a Docker volume) and `celld` (the node) |
| `node/` | celld node image: entrypoint (bucket setup, router deploy, node, bundled sites) and `push.sh` |
| `router/` | The host-header router Worker and its config template |
| `tools/pack.mjs` | Packs a built site into a deploy payload |
| `tools/deploy.sh` | Builds a site and deploys it to the running router |
| `sites/example/` | Test app: page views and a guestbook in Durable Objects, bundled into the image |

## Run

```sh
cp .env.example .env    # fill in random values, chmod 600
docker compose up -d --build
```

The test app is served at `https://$HOST_DOMAIN` (set in `.env`). On every
start the `celld` container creates the bucket if it is missing, deploys the
router, starts the node and deploys the bundled example, so a fresh or wiped
bucket needs no manual steps.

## Deploy a site

Sites are SvelteKit apps built with `@sveltejs/adapter-cloudflare`:

```sh
tools/deploy.sh path/to/site blog.example.com
```

Then add the hostname to Traefik with `SITES_RULE` in `.env`, e.g.
``SITES_RULE=Host(`celld-test.example.com`) || Host(`blog.example.com`)``,
and run `docker compose up -d`. Each deploy is a new version keyed by a hash of
its content; the switch to it happens after everything is stored, and old
versions stay in the bucket (rollback = point `site:<host>` at an old version).

Site code notes (SvelteKit 3):

- Bindings come from `import { env } from 'cloudflare:workers'`; there is no
  `platform.env`. A site gets exactly two: `ASSETS` (its own files) and `OBJECTS`.
- `$lib` is now `#lib`, and subpath imports need the file extension
  (`#lib/server/objects.ts`).

## Durable Objects

Export classes from `src/objects.ts` and call them from routes:

```ts
await env.OBJECTS.call('Guestbook', 'main', 'add', name, message);
```

Each `(site, class, name)` is a separate object with its own SQLite database.
The router runs it as a facet of its `SiteObject`, keyed by the site's
hostname, so a site can only reach its own objects. Data survives redeploys.
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
- **Old site versions** are never deleted: roughly one payload (~0.5 MB for
  the example) per deploy.

## Security

- celld's internal operator listener (unauthenticated) stays on 127.0.0.1
  inside the container; the bucket is only on the project network.
- The deploy API answers only for the hostname `admin.internal`, which Traefik
  never routes, and requires `ADMIN_TOKEN`; `tools/deploy.sh` reaches it with
  `docker compose exec`.
- Sites are isolated from each other and from the router (separate isolates,
  only `ASSETS` and `OBJECTS`), and each request is capped at 1 s of CPU. The
  isolates share one process, so this is not a boundary against hostile code:
  fine for your own sites only.
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

Static assets are slower than page renders because each goes through the
site's isolate and a KV read; caching immutable `_app/` files in the router
would help.

## Status

celld (v0.6.3) is alpha; Dynamic Workers and facets are beta at Cloudflare.
celld's ideas are being merged into Cloudflare's workerd, so expect a
migration at some point; sites are standard `adapter-cloudflare` builds.
