# Site contract

What a site must look like to run on celld-sites, whatever the framework. The
router (`router/index.js`) loads each site into its own Dynamic Worker isolate,
picked by the `Host` header.

## Build output

A site is two things, both optional (but not both absent):

- **A worker module**: an ES module with `export default { fetch(request, env, ctx) }`,
  the Cloudflare Workers module format. Its imports are bundled into one file
  by `tools/pack.mjs` (esbuild); `cloudflare:*` and `node:*` stay external.
- **A static directory**: files served as-is.

Describe them in `celld.json` next to the site's `package.json` (paths are
relative to the site directory):

```json
{
	"worker": ".output/server/index.mjs",
	"assets": ".output/public",
	"objects": "server/objects.ts",
	"immutable": ["_nuxt/"],
	"notFound": "none",
	"exclude": []
}
```

| Field | Meaning |
| --- | --- |
| `worker` | Server entry with `export default { fetch }`. Omit for a static-only site. |
| `assets` | Directory of static files. |
| `objects` | Module exporting the site's Durable Object classes (see below). |
| `immutable` | Path prefixes of content-hashed files (1-year cache). Default `["_app/immutable/", "_nuxt/", "assets/"]`. |
| `notFound` | `"spa"`: a static-only site answers page navigations to unknown paths with `index.html`. Default `"none"`. |
| `exclude` | Asset paths never to serve (adapters' `_worker.js`, `_routes.json`, `_headers`, `_redirects`, `.assetsignore` are always excluded). |

Without `celld.json` the SvelteKit `adapter-cloudflare` layout is assumed.
The site needs `esbuild` in its devDependencies.

## Request handling

1. `GET`/`HEAD` for a path that exists as a static file is answered by the
   router directly (exact path, then `<path>/index.html`, then `<path>.html`).
   The worker never sees these requests.
2. Everything else goes to the worker's `fetch`.
3. Behind Traefik, the router rewrites the request URL to `https://` (from
   `X-Forwarded-Proto`), so origin checks see the browser's origin.

## Bindings

A site's `env` has exactly two bindings, both in the `fetch` handler's `env`
argument and via `import { env } from "cloudflare:workers"`:

- `ASSETS.fetch(request | url)`: the site's own static files.
- `OBJECTS.call(className, name, method, ...args)`: calls `method` on the
  Durable Object `className` named `name`, and returns its result.

There is **no KV, D1, R2, Queues or secrets**, and **no outbound network**:
`fetch()` to anything except the bindings throws. Each request has 1 second
of CPU. The runtime is workerd-compatible with compatibility date
`2026-10-01` and `nodejs_compat`.

### Runtime gaps the platform papers over

celld 0.6.3 exposes some Node/console APIs that throw "not implemented". The
platform fixes the ones frameworks have hit, so site code needs nothing:

- `console.createTask` (Nitro's `hookable`): removed by the router's prelude.
- global `process.nextTick`: replaced with a `queueMicrotask` version by the prelude.
- `setImmediate`/`clearImmediate` imported from `node:timers` (Nitro/h3): the
  packer points `node:timers` imports at a shim built on the working globals.

Still broken and not patched: `nextTick` imported from `node:process` (the
module object is separate from the global and can't be patched). If a build
fails with `... is not implemented in celld`, find the caller and add a fix in
the router prelude (globals) or the packer (imports).

## Durable Objects

Export classes from the `objects` module:

```ts
import { DurableObject } from "cloudflare:workers";

export class Notes extends DurableObject {
	add(text: string) {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT, at TEXT)");
		sql.exec("INSERT INTO notes (text, at) VALUES (?, ?)", text, new Date().toISOString());
		return this.list();
	}
	list() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT, at TEXT)");
		return this.ctx.storage.sql.exec("SELECT id, text, at FROM notes ORDER BY id DESC").toArray();
	}
}
```

and call them from server code: `await env.OBJECTS.call("Notes", "main", "add", text)`.

- Each `(className, name)` is a separate object with its own SQLite database;
  data survives redeploys.
- Arguments and return values must be plain data (structured-cloneable):
  no `Request`, `Response`, functions or class instances.
- Objects cannot set alarms.

## Deploy and test

```sh
tools/deploy.sh sites/<name> <hostname>        # npm run build, pack, upload, activate
docker exec celld-sites-celld-1 curl -s -H 'Host: <hostname>' http://127.0.0.1:8080/
```

Requests made this way are plain `http://`, so a POST that is origin-checked
needs `-H 'Origin: http://<hostname>'`. A hostname is reachable in a browser
only after it is added to `SITES_RULE` in `.env`.

Limits: a single static file can be at most 20 MiB (the packer refuses larger
ones, and the router answers 413), the server code at most 16 MiB. Symlinks in
the static directory are refused. Data belongs to the site id (the first
hostname deployed to), so serve a site under a new name with an alias
(`tools/admin.sh PUT '/alias?host=<new>&site=<id>'`) rather than deploying it
to the new name.
