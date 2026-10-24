# Nuxt on celld-sites

**Status: works.** SSR with Durable Object data, the notes API (GET/POST with
validation and an Origin check) and router-served hashed assets are verified on
the node. It needed two platform fixes for celld runtime gaps, described under
"Runtime gaps" below; both now apply to every site automatically.

## Versions

| Component | Version |
| --- | --- |
| Node / npm | 25.9.0 / 11.12.1 |
| nuxt | 4.6.2 (nitropack 2.13.5, Nitro preset `cloudflare-module`) |
| vue / vue-router | 3.5.44 / 5.4.0 |
| esbuild | 0.28.2 (devDependency, needed by `tools/pack.mjs`) |

Nuxt 4.6.2 declares `node: ^22.22.3 || ^24.15.0 || >=26`. On Node 25 npm prints
`EBADENGINE` warnings; the build still runs. Use a supported Node for production builds.

## Setup

1. `package.json`: `nuxt`, `vue`, `vue-router` as dependencies and `esbuild` as a
   devDependency. Scripts: `"build": "nuxt build"`, `"postinstall": "nuxt prepare"`.
   Use `npm`, not `bunx`/`bun`.
2. `nuxt.config.ts`:

   ```ts
   export default defineNuxtConfig({
   	compatibilityDate: '2026-10-01',
   	devtools: { enabled: false },
   	nitro: { preset: 'cloudflare-module' },
   });
   ```

3. `celld.json` (paths relative to the site directory). Verified against the
   build output:

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

   The build also writes `.output/public/_headers` (Nuxt's cache rules). `pack.mjs`
   always excludes `_headers`, so it is not served.
4. `.gitignore`: `node_modules`, `.output`, `.nuxt`, `.data`.

## Durable Objects

`server/objects.ts` exports the classes, `pack.mjs` re-exports them from the
worker entry, and `cloudflare:workers` stays external:

```ts
import { DurableObject } from 'cloudflare:workers';

export class Notes extends DurableObject {
	add(text: string) {
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS notes (...)');
		this.ctx.storage.sql.exec('INSERT INTO notes (text, at) VALUES (?, ?)', text, new Date().toISOString());
		return this.list();
	}
	list() { /* SELECT ... ORDER BY id DESC */ }
}
```

Call them from server routes through a helper in `server/utils/objects.ts`:

```ts
import { env } from 'cloudflare:workers';
export const callObject = (cls: string, name: string, method: string, ...args: unknown[]) =>
	env.OBJECTS.call(cls, name, method, ...args);
```

Arguments and return values must be plain data. `env.OBJECTS.call` is only
available inside a request.

Routes in the example: `GET /api/notes`, `POST /api/notes` (JSON `{ "text" }`,
trimmed, 1-280 characters, 400 otherwise, same-origin check on the `Origin`
header), `GET /api/views` (counts one page view; the page calls it once per SSR
render). The page loads both with `useAsyncData` during SSR.

## Build output notes

- `cloudflare:workers` is left as a bare import in `.output/server/index.mjs` and
  its chunks, so `pack.mjs` keeps it external without changes.
- Static files are in `.output/public/_nuxt/` with content-hashed names
  (`_nuxt/<hash>.js`, `*.css`), which `immutable: ["_nuxt/"]` covers.
- `.output/public/_nuxt/builds/latest.json` is not hashed and sits under the
  `_nuxt/` prefix, so the router gives it the 1-year immutable header too. Nuxt
  requests it with a `?<timestamp>` query for its outdated-build check, which
  makes the cache key change on each request, so this is harmless in practice.
  The prefix list cannot exclude a single file.

## Runtime gaps (fixed in the platform)

Nuxt hit two APIs that celld 0.6.3 exposes but that throw "not implemented".
Neither is Nuxt's fault, and no site code changes are needed now:

1. **`console.createTask`.** The `hookable` library (Nitro, unhead) uses it when
   it exists (`cn = void 0 !== console.createTask ? console.createTask : ...`)
   and calls it on every hook dispatch, so every request failed with
   `console.createTask() is not implemented`. Fix: the router loads each site
   through a prelude module that removes a throwing `console.createTask` (and
   repairs a throwing global `process.nextTick`) before site code runs.
2. **`setImmediate` from `node:timers`.** h3's `send()` calls `setImmediate`, and
   Nitro's build turns that global into `import { setImmediate } from "node:timers"`.
   celld's global `setImmediate` works, but the `node:timers` export throws
   `node:timers.setImmediate is not implemented in celld`. A prelude cannot patch
   an import, so `tools/pack.mjs` now points every site's `node:timers` imports at
   a shim built on the global timer functions.

How it was found: the Nitro error page hides stacks, so a temporary Nitro plugin
logged them (`nitroApp.hooks.hook("error", (e) => console.log(e.stack))`), and a
throwaway probe site checked which globals and module exports throw.

## Verified

After the platform fixes, against the running node with
`tools/deploy.sh sites/nuxt nuxt.test` (curl inside the node):

- `GET /`: 200, server-rendered with the notes and the page-view counter, which
  increments per request (14, then 15).
- `POST /api/notes` (JSON, `Origin: http://nuxt.test`): 200 and the note is
  stored; whitespace-only text: 400; foreign `Origin`: 403.
- `GET /api/notes`: 200 with the notes as JSON.
- `GET /_nuxt/<hash>.js`: 200 with `cache-control: public, immutable, max-age=31536000`.
- No errors in the node log for these requests.
- Payload: ~0.8 MB (well under the 10 MB limit).

Not verified: browser hydration and the client-side form (curl only), typecheck.
