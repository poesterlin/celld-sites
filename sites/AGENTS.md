# Building sites for celld-sites

Instructions for any agent creating or changing a site that is deployed with
this repo's `tools/deploy.sh`. Commands assume the repo root as the working
directory. Read these too:

- `../docs/SITES.md`: the site contract (authoritative; this file summarizes it).
- `sites/<framework>/RECIPE.md`: worked setups for SvelteKit, Nuxt and
  TanStack Start, with pitfalls actually hit and what was verified.

## What a site is

A site is a **Cloudflare Workers module** (`export default { fetch(request, env, ctx) }`)
plus a **directory of static files**, described by `celld.json` in the site
directory. One celld node runs every site, each in its own V8 isolate, and
routes requests by the `Host` header:

1. `GET`/`HEAD` for a path that exists as a static file is served by the router
   directly (exact path, then `<path>/index.html`, then `<path>.html`). Your
   worker never sees those requests.
2. Everything else goes to your worker's `fetch`.
3. Behind the proxy, the request URL is already rewritten to `https://`, so
   framework origin/CSRF checks work.

A site's **id** is the first hostname it was deployed to. The id owns the site's
versions and Durable Objects; other hostnames can be aliases of it.

## Runtime constraints

Design within these; none of them can be worked around from site code.

| Constraint | Consequence |
| --- | --- |
| **No outbound network.** `fetch()`/`connect()` to anything but the bindings throws. | No external APIs, CDNs or webhooks at runtime. Bundle everything; fetch data at build time if needed. |
| **Only two bindings:** `ASSETS` (your static files) and `OBJECTS` (your Durable Objects). | No KV, D1, R2, Queues, email, images, cron or secrets. Store state in Durable Objects (SQLite). |
| **No secrets.** There are no env vars or secret bindings. | Never put secrets in site code: the server bundle and every static file are readable by the operator, and static files are public. |
| **1 second of CPU per request,** including Durable Object calls; **30 s wall clock** to start the response (object calls: 24 s). | Keep handlers small; a runaway loop is killed with a 500, a request that waits forever gets a 504. |
| **Fixed runtime:** `nodejs_compat`, compatibility date `2026-10-01` (or `compatibilityDate` in `celld.json`), on celld (alpha). | Some Node APIs exist but throw `... is not implemented in celld`. The platform patches `console.createTask`, the global `process.nextTick` and `setImmediate`/`clearImmediate` from `node:timers`; `nextTick` imported from `node:process` still throws. |
| **Upload limits:** 20 MiB per static file, 16 MiB of server code; no symlinks in the static directory. | Keep large media out of sites. |

## celld.json

```json
{
	"worker": "<server entry module, export default { fetch }>",
	"assets": "<directory of static files>",
	"objects": "<module exporting Durable Object classes>",
	"immutable": ["<prefix of content-hashed files>/"],
	"notFound": "none"
}
```

All paths are relative to the site directory and point at **build output**.
Omit `worker` for a static-only site; use `"notFound": "spa"` for a client-side
router (unknown page navigations get `index.html`). The default `immutable` is
whichever of `_app/immutable/` and `_nuxt/` the build has, plus `assets/` only
if every file in it has a content hash in its name; `mutable` lists exact
paths under those prefixes that change per build (Nuxt's
`_nuxt/builds/latest.json` is always included). Without `celld.json` the SvelteKit
`adapter-cloudflare` layout is assumed. Put `esbuild` in devDependencies: the
packer needs it.

## Framework setup

| Framework | Build target | `worker` | `assets` | `immutable` |
| --- | --- | --- | --- | --- |
| SvelteKit 3 | `@sveltejs/adapter-cloudflare` (in `vite.config.ts`) | `.svelte-kit/cloudflare/_worker.js` | `.svelte-kit/cloudflare` | `_app/immutable/` |
| Nuxt 4 | Nitro preset `cloudflare-module` | `.output/server/index.mjs` | `.output/public` | `_nuxt/` |
| TanStack Start | `@cloudflare/vite-plugin` (`viteEnvironment: { name: "ssr" }`) + `tanstackStart()` | `dist/server/index.js` | `dist/client` | `assets/` |
| Static / SPA | any static build | (omit) | `dist` or similar | e.g. `assets/` |

In server code, get bindings with `import { env } from "cloudflare:workers"`
(SvelteKit 3 has no `platform.env`). Keep that import out of client code.
Framework-specific traps:

- **SvelteKit 3:** `sv create` defaults to `adapter-auto` (replace it); `$lib`
  became `#lib` and imports need the file extension; set
  `version: { name: <git commit> }`, because the default build timestamp makes
  every rebuild a new deploy version (see `sites/example/vite.config.ts`).
- **Nuxt:** the error page hides stack traces (see Debugging); Nuxt may warn
  about the Node version during the build, which is harmless.
- **TanStack Start:** server function APIs change between releases (check the
  installed version, not just the docs); server function requests use a special
  serialization, so test them through the UI or the page, not hand-written JSON.

Scaffold with `npm`/`npx`.

## Durable Objects

```ts
// objects module (celld.json "objects")
import { DurableObject } from "cloudflare:workers";

export class Notes extends DurableObject {
	#init() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)");
	}
	add(text: string) {
		this.#init();
		this.ctx.storage.sql.exec("INSERT INTO notes (text, at) VALUES (?, ?)", text, new Date().toISOString());
		return this.list();
	}
	list() {
		this.#init();
		return this.ctx.storage.sql.exec("SELECT id, text, at FROM notes ORDER BY id DESC").toArray();
	}
}

// server code
import { env } from "cloudflare:workers";
const notes = await env.OBJECTS.call("Notes", "main", "add", text);
```

- Each `(class, name)` is a separate object with its own SQLite database.
  Choose names deliberately: every distinct name is a new object and a new
  index entry, so don't derive names from unbounded input such as random ids.
- **Arguments and return values must be plain data** (no `Request`, `Response`,
  functions or class instances); calls are RPC methods, not `fetch`.
- **Data outlives your code.** Objects keep their data across redeploys, so
  schema changes are migrations that each object runs on itself. Use the
  pattern in `docs/SITES.md` (Migrations): an append-only list run in the
  constructor under `blockConcurrencyWhile`, each step in `transactionSync`,
  the version in a `_schema` table (`PRAGMA user_version` and raw `BEGIN` are
  not allowed). Keep each deploy's migrations additive, so a rollback and the
  requests still on the old version keep working; remove or rename columns
  only in a later deploy. Never assume an empty database.
- Validate input before calling an object.
- Objects can't set alarms, and WebSockets in an object don't hibernate.
- **Keep side effects out of page loaders.** Frameworks re-run loaders after a
  form submission or navigation, so a counter incremented in a loader counts
  twice. Do writes in actions or API routes.
- **Seed and export through object methods, never through routes.** Sites have
  no secrets, so a seed or import route would be open to anyone. Give the class
  methods such as `seed(rows, { replace })` (validated like user input, and
  idempotent with `replace`) and `export()` (returning `seed()`'s input format),
  and call them with `tools/seed.mjs`, which goes through the admin API. Keep a
  `seed.json` with demo data in the site directory. See `sites/sveltekit`.

## Workflow

The production node holds production sites only. Preview and test locally.

1. **Build the site in its own directory** (`sites/<name>/`) with a `.gitignore`
   for `node_modules` and the build output.
2. **UI work:** the framework's dev server (`npm run dev`). It has no `OBJECTS`
   binding, so Durable Object code needs step 3.
3. **Preview locally:** `tools/preview.sh sites/<name> [port]` runs the
   production router under `celld dev` with the site deployed (default
   http://localhost:8790/, any hostname works). Re-run it after each change
   (~5 s); local data persists in `sites/<name>/.celld-preview/`. Seed it with
   `node tools/seed.mjs --preview sites/<name> sites/<name>/seed.json`; start
   over with `tools/preview.sh sites/<name> --reset`. Stop it when you are
   done: `tools/preview.sh sites/<name> --stop`.
4. **Verify** (checklist below) against the preview with curl and a browser.
   The packer prints the version, the asset count and the server code size;
   check them. Requests are plain `http://`, so origin-checked POSTs need
   `-H 'Origin: http://localhost:<port>'`.
5. **Deploy to production** only when asked: `tools/deploy.sh sites/<name> <hostname>`.
   To serve an existing site under a new hostname, alias it
   (`tools/admin.sh PUT '/alias?host=<new>&site=<id>'`); deploying to the new
   name creates an empty site instead. Seed production with
   `node tools/seed.mjs <hostname> sites/<name>/seed.json` only when asked.
6. **Roll back** with `tools/admin.sh POST '/activate?host=<host>&version=<previous id>'`;
   the dashboard shows each site's version history.

## Debugging

- Server errors usually show up only as a 500 page. The node's log has the real
  message: `sites/<name>/.celld-preview/celld.log` for a preview, and
  `docker compose logs --since 5m celld | grep cell_console` in production.
- Frameworks may hide stacks (Nitro does). Add a temporary error hook that logs
  `error.stack`, re-run the preview, reproduce, then remove the hook.
- `... is not implemented in celld` is a **platform gap**, not a bug in your
  site. Find the caller from the stack and report it with the stack. Fixes
  belong in the router prelude (for globals) or the packer (for imports), not in
  each site.
- A `403` on a POST is usually the framework's origin check: send a matching
  `Origin` header.

## Done means verified

Check each item with real requests, then record the results honestly in the
site's `RECIPE.md` or `README.md`, including anything you did not verify:

- [ ] The page renders on the server, with data from Durable Objects in the HTML.
- [ ] Mutations work; invalid input gets a 4xx; a foreign `Origin` gets 403.
- [ ] API routes return the expected JSON.
- [ ] A content-hashed asset returns 200 with `cache-control: public, immutable, max-age=31536000`.
- [ ] A redeploy (re-running the preview) keeps the data; `seed.json` loads.
- [ ] No errors in the node log for these requests.
- [ ] **In a real browser:** the page hydrates, forms and buttons work, and the
      console has no errors. curl alone misses client-side breakage.

## Rules

- Only edit your site's directory. Don't change `router/`, `tools/`, `node/`,
  `dashboard/`, `docs/`, `compose.yaml` or other sites unless the task is
  platform work; if the platform blocks you, stop and describe the problem
  precisely instead of working around it in the site. Platform work must keep
  `npm test --prefix tools` passing (and add tests for new behaviour).
- Don't restart, stop or rebuild containers (`docker compose up/down/restart`)
  and don't kill processes other than your own preview (`--stop`). Production
  deploys, seeding, and `tools/admin.sh` prune or alias changes only when asked.
- Never print `.env` or tokens.
- Keep deployment-specific hostnames out of committed files; use
  `example.com` or `.test` names in docs and code.
