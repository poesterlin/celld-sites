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
| **1 second of CPU per request,** including Durable Object calls. | Keep handlers small; a runaway loop is killed with a 500. |
| **Fixed runtime:** compatibility date `2026-10-01` with `nodejs_compat`, on celld (alpha). | Some Node APIs exist but throw `... is not implemented in celld`. The platform patches `console.createTask`, the global `process.nextTick` and `setImmediate`/`clearImmediate` from `node:timers`; `nextTick` imported from `node:process` still throws. |
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
`["_app/immutable/", "_nuxt/", "assets/"]`. Without `celld.json` the SvelteKit
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
- **Data outlives your code.** Objects keep their data across redeploys, so a
  schema change needs a migration in code (`CREATE ... IF NOT EXISTS`, guarded
  `ALTER TABLE`). Never assume an empty database.
- Validate input before calling an object.
- Objects can't set alarms, and WebSockets in an object don't hibernate.
- **Keep side effects out of page loaders.** Frameworks re-run loaders after a
  form submission or navigation, so a counter incremented in a loader counts
  twice. Do writes in actions or API routes.

## Workflow

1. **Build the site in its own directory** (`sites/<name>/`) with a `.gitignore`
   for `node_modules` and the build output.
2. **Deploy to a test hostname first:** `tools/deploy.sh sites/<name> <name>.test`.
   The packer prints the version, the asset count and the server code size;
   check them. Reuse the same test hostname for every round: there is no
   command to delete a site, and every new hostname is a new site with its own data.
3. **Verify** (checklist below) with requests inside the node:
   `docker compose exec -T celld curl -s -H 'Host: <name>.test' http://127.0.0.1:8080/`.
   These are plain `http://`, so origin-checked POSTs need
   `-H 'Origin: http://<name>.test'`.
4. **Deploy to the real hostname** only after that. To use a new hostname for
   an existing site, alias it (`tools/admin.sh PUT '/alias?host=<new>&site=<id>'`);
   deploying to the new name creates an empty site instead.
5. **Roll back** with `tools/admin.sh POST '/activate?host=<host>&version=<previous id>'`;
   the dashboard shows each site's version history.

## Debugging

- Server errors usually show up only as a 500 page. The node's log has the real
  message: `docker compose logs --since 5m celld | grep cell_console`.
- Frameworks may hide stacks (Nitro does). Add a temporary error hook that logs
  `error.stack`, redeploy to the test hostname, reproduce, then remove the hook.
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
- [ ] A redeploy keeps the data.
- [ ] No errors in the node log for these requests.
- [ ] **In a real browser:** the page hydrates, forms and buttons work, and the
      console has no errors. curl alone misses client-side breakage.

## Rules

- Only edit your site's directory. Don't change `router/`, `tools/`, `node/`,
  `dashboard/`, `docs/`, `compose.yaml` or other sites unless the task is
  platform work; if the platform blocks you, stop and describe the problem
  precisely instead of working around it in the site.
- Don't restart, stop or rebuild containers (`docker compose up/down/restart`)
  and don't kill processes; deploying and testing need none of that. Run
  `tools/admin.sh` prune or alias changes only when asked.
- Never print `.env` or tokens.
- Keep deployment-specific hostnames out of committed files; use
  `example.com` or `.test` names in docs and code.
