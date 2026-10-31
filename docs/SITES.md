# Site contract

What a site must look like to run on celld-sites, whatever the framework. The
router (`router/index.ts`) loads each site into its own Dynamic Worker isolate,
picked by the `Host` header.

## Build output

A site is two things, both optional (but not both absent):

- **A worker module**: an ES module with `export default { fetch(request, env, ctx) }`,
  the Cloudflare Workers module format. Its imports are bundled into one file
  by `tools/pack.ts` (esbuild); `cloudflare:*` and `node:*` stay external.
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
| `immutable` | Path prefixes of content-hashed files (1-year cache). Default: whichever of `_app/immutable/` and `_nuxt/` exist, plus `assets/` if every file in it has a hash in its name. |
| `mutable` | Exact paths under those prefixes that change between builds (served `no-cache`). `_nuxt/builds/latest.json` is always included. |
| `compatibilityDate` | workerd compatibility date, `YYYY-MM-DD`. Default `2026-10-01`. |
| `check` | Path a deploy requests on the new version before activating it (Durable Objects in an empty scratch namespace) and probes on the live site after; a 5xx stops or rolls back the deploy. Default `"/"`; `false` turns it off. If the default `/` is a static file and the site has a worker, the check also requests `/~check-<version>` so a broken worker cannot pass on the static page; a custom path is used as given. |
| `notFound` | `"spa"`: a static-only site answers page navigations to unknown paths with `index.html`. Default `"none"`. |
| `minify` | `true` minifies the bundled server code (default `false`), for big builds near the 16 MiB code limit. |
| `exclude` | Asset paths never to serve (adapters' `_worker.js`, `_routes.json`, `_headers`, `_redirects`, `.assetsignore` are always excluded). |

Without `celld.json` the SvelteKit `adapter-cloudflare` layout is assumed.
EmDash (Astro) sites need more than a `celld.json`: deploy them with
`tools/deploy-emdash.sh` (README, "EmDash sites").
The site needs `esbuild` in its devDependencies.

## Request handling

1. `GET`/`HEAD` for a path that exists as a static file is answered by the
   router directly (exact path, then `<path>/index.html`, then `<path>.html`).
   The worker never sees these requests. Each response has an ETag and a
   matching `If-None-Match` gets 304; non-immutable files are `no-cache`
   (revalidated every time, which is then cheap).
2. Everything else goes to the worker's `fetch`.
3. Behind Traefik, the router rewrites the request URL to `https://` (from
   `X-Forwarded-Proto`), so origin checks see the browser's origin.

Inside a [Hamstr](../hamstr/README.md) grain, requests also carry the visitor's
identity and permissions (`X-Hamstr-User-Id`, `-Username`, `-Permissions`,
`-Role`); see the Hamstr README for the header contract. Outside Hamstr those
headers are not set and must not be trusted.

## Sign-in

A site that needs to know who is visiting declares it in `celld.json`; there is
no auth code to write:

```json
{ "auth": "required" }
```

`"required"`: visitors sign in before they see anything. `"optional"`: anyone
may open the site, and signed-in people are recognised. That is all a site
says. *Who* may enter is decided in one place, Hamstr's **Settings → Sites**:
by default everyone the operator has let in, or only some groups and people. The
page can also protect a site that declares nothing, or open one up.

Sign-in is the platform's: the router sends a visitor without a valid cookie to
[Hamstr](../hamstr/README.md) (`AUTH_URL`), which signs them in with whichever
provider they use (OIDC, GitHub, passkey), checks the rule, and sends them back.
The site then receives these headers (the router removes any it finds on the
incoming request first, so they cannot be forged):

| Header | Value |
| --- | --- |
| `X-Celld-User-Id` | stable id of the person |
| `X-Celld-User-Name` | display name, URI-encoded |
| `X-Celld-User-Email` | email, when the provider gave one |
| `X-Celld-User-Groups` | comma-separated group names, each URI-encoded |
| `X-Celld-User-Role` | `owner`, `admin` or `member` |

On a `public` site the headers are absent for visitors who are not signed in.
Static sites (no worker) can ask `GET /.celld/auth/me` for
`{"user": {id, name, email, groups, role} | null, "mode"}`; `/.celld/auth/logout`
signs out. The router keeps these paths and the session cookie
(`celld_auth` / `__Host-celld_auth`) to itself: the cookie is never forwarded to
the site, and it is host-only, so one site's cookie means nothing to another.

Things to know:

- A navigation without a cookie is redirected to sign in; other requests (fetch,
  images, POSTs) get a plain `401`. A node without `AUTH_URL`/`AUTH_KEY` answers
  `503` for gated sites rather than serving them open.
- Removing a person or group takes effect when their site cookie expires: up to
  15 minutes. Disabling a person ends their auth-service sessions at once.
- The mode belongs to the site, not the build: a deploy records it when it is
  activated, a rollback restores the mode that version was deployed with, and
  the same build on another host has no effect on this one. It is not part of
  the version id, so changing only `auth` needs no rebuild.
- Do not trust the headers outside a gated site. They exist only after the
  router has verified the cookie.

## Bindings

A site's `env` has exactly two bindings, both in the `fetch` handler's `env`
argument and via `import { env } from "cloudflare:workers"`:

- `ASSETS.fetch(request | url)`: the site's own static files.
- `OBJECTS.call(className, name, method, ...args)`: calls `method` on the
  Durable Object `className` named `name`, and returns its result.

There is **no KV, D1, R2, Queues or secrets**, and **no outbound network by
default**: `fetch()` throws until the operator allowlists hostnames for the
site (`PUT /__admin/egress?host=…`, a JSON array). With a list, `fetch()`
reaches exactly those hosts, over HTTPS on port 443 only, and gets a 403 for
anything else (plain `http:` and other ports included). A changed list applies
within a minute. A deploy's check runs with the site's list. `connect()` and
WebSockets stay unavailable, redirects come back to the site rather than being
followed (so every hop is checked), and IP literals and internal names cannot
be allowlisted. Each request has 1 second
of CPU, and has to start its response within 30 s (`SITE_TIMEOUT_SECS`, else
504); an object call gives up after 80% of that. The runtime is
workerd-compatible with `nodejs_compat` and compatibility date `2026-10-01`, or
`compatibilityDate` (YYYY-MM-DD) from `celld.json`. celld 0.6.3 accepts any
date without complaint, so test a site with a non-default date in a preview.

Per-site quotas: at most 1000 Durable Objects (`SITE_MAX_OBJECTS`; the call that
would create another throws "object quota reached"), 1000 subrequests per
request (object calls plus egress fetches), and 128 concurrent requests per site
per router isolate (`SITE_MAX_INFLIGHT`, above that a 503 with `Retry-After`).
Static files do not count against CPU, but they do count against in-flight.

### Runtime gaps the platform papers over

celld 0.6.3 exposes some Node/console APIs that throw "not implemented". The
platform fixes the ones frameworks have hit, so site code needs nothing:

- `console.createTask` (Nitro's `hookable`): removed by the router's prelude.
- global `process.nextTick`: replaced with a `queueMicrotask` version by the prelude.
- `setImmediate`/`clearImmediate` imported from `node:timers` (Nitro/h3): the
  packer points `node:timers` imports at a shim built on the working globals.

- Bare Node built-in imports (`"fs"`, `"path"`, bundled CommonJS in Astro
  builds): the packer turns them into `node:fs`, `node:path`.

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
- `className` and `method` must be identifiers of at most 128 characters and
  cannot be `Object.prototype` names (`constructor`, `__proto__`, `toString`,
  …); `name` is at most 200 characters, and the whole `site|class|name` key at
  most 500 bytes. A site may create `SITE_MAX_OBJECTS` objects (default 1000);
  creating another throws `object quota reached`.
- The request context passed to `fetch` is a frozen object with `waitUntil`,
  `abort` and `passThroughOnException`. `ctx.exports` and `ctx.props` are not
  exposed.

## Migrations

Each Durable Object has its own SQLite database, so there is no central
database to migrate: **each object migrates itself**, in its constructor, the
first time new code runs in it. After a deploy that is the object's next call,
so objects migrate lazily, one by one, while the site is live. The pattern
(tested on celld-sites, including under load):

```js
import { DurableObject } from "cloudflare:workers";

// Append-only: never edit or reorder an entry once it is deployed.
const MIGRATIONS = [
	(sql) => sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)"),
	(sql) => sql.exec("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"),
];

function migrate(storage) {
	const sql = storage.sql;
	sql.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)");
	let version = sql.exec("SELECT version FROM _schema").toArray()[0]?.version;
	if (version === undefined) {
		sql.exec("INSERT INTO _schema (version) VALUES (0)");
		version = 0;
	}
	for (; version < MIGRATIONS.length; version++) {
		storage.transactionSync(() => {
			MIGRATIONS[version](sql);
			sql.exec("UPDATE _schema SET version = ?", version + 1);
		});
	}
}

export class Notes extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => migrate(ctx.storage)); // before any call
	}
}
```

- `blockConcurrencyWhile` in the constructor runs the migrations before any
  call reaches the object; `transactionSync` makes each step all-or-nothing
  (it rolls back if the step throws).
- Track the version in a table: `PRAGMA user_version` is not allowed, and
  neither is raw `BEGIN`. `ALTER TABLE ... ADD COLUMN` and table rebuilds
  (create, copy, drop, rename inside `transactionSync`) work.
- If an object's table predates the `_schema` table, count the steps it already
  has as done (check `sqlite_master`) instead of re-running them.

**Live deploys and rollbacks.** During a deploy, requests that started on the
old version can still reach an object that already runs the new code, and a
rollback runs the old code on the migrated schema. So make each deploy's
migrations **additive** (expand): add tables and columns with defaults, and
have code name its columns instead of `SELECT *`. Remove or rename things only
in a later deploy (contract), once every object has migrated and you won't roll
back. Tested: 13 switches between a schema-1 and a schema-2 version under
continuous writes and reads gave no failed request and no lost or duplicated
write; the old version kept working on the migrated table.

**Objects that are never called stay on the old schema**, which is fine:
they migrate on their next call. To migrate one now, call any method on it
(`node tools/seed.ts <hostname> --call <Class> <name> <method>`); the
dashboard lists a site's objects.

## Preview, deploy, seed

```sh
tools/preview.sh sites/<name>                    # local preview, http://localhost:8790/
node tools/seed.ts --preview sites/<name> sites/<name>/seed.json
tools/deploy.sh sites/<name> <hostname>          # production: pack, upload, activate (build first, or add --build)
node tools/seed.ts <hostname> sites/<name>/seed.json
tools/update.sh sites/<name> <hostname> [--rehearse <copy>]   # live site with data: dump, rehearse, deploy
```

A preview runs the production router under `celld dev` with the site
deployed, so it behaves like production, including bindings and runtime
patches. Framework dev servers lack the `OBJECTS` binding. Local data lives in
`<site>/.celld-preview/`. Preview requests are plain `http://`, so a POST that
is origin-checked needs `-H 'Origin: http://localhost:<port>'`. A production
hostname is reachable in a browser only if Traefik routes it to celld:
`SITES_RULE` in `.env` is a pattern for site hostnames, so a matching name
works as soon as it is deployed.

**Backups.** The router can dump and restore any site's objects without your
code's help (`/__admin/dump`, `/__admin/restore`; see the README). It adds a
method named `__celldData` to every class your site exports, so don't use
method names starting with `__celld`: `OBJECTS.call` refuses them. A class
must keep its `ctx` (extend `DurableObject`, or store `state` as `this.state`)
for its storage to be reachable.

**Seeding.** Sites have no secrets, so they can't guard a seed route. Put
`seed()`/`export()` methods on the object classes; `tools/seed.ts` calls them
through the admin endpoint `POST /__admin/call?host=&class=&name=&method=`
(body: JSON array of arguments, deploy token required). The calls file is a
JSON array of `{ "class", "name", "method", "args" }`; add `"version"` to seed
a site that is not live yet with a version uploaded for it (refused once the
site is live: only the active version runs on live data).

**Limits.** A single static file can be at most 20 MiB (the packer refuses
larger ones, and the router answers 413), the server code at most 16 MiB.
Symlinks in the static directory are refused. Asset paths are relative (no
leading `/`, no `..` segment, no backslash, at most 400 bytes). Data belongs to
the site id (the first hostname deployed to), so serve a site under a new name
with an alias (`tools/admin.sh PUT '/alias?host=<new>&site=<id>'`) rather than
deploying it to the new name.
