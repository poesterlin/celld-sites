# SvelteKit on celld-sites

How to build a SvelteKit app that runs on the celld-sites platform, using the
`notes board` example in this directory. The platform contract is
`docs/SITES.md`; this recipe shows how the pieces fit for SvelteKit 3.

The example has: a server-rendered `/` with a page-view counter and a list of
notes (both read from Durable Objects in `load`), a form action that adds a
note (works with and without JavaScript, `use:enhance` on the page), a JSON
route `GET /api/notes`, and hashed static assets.

## Layout

```
sites/sveltekit/
  celld.json               explicit site layout (pack.mjs reads this)
  vite.config.ts           adapter-cloudflare is configured here (no svelte.config.js)
  package.json             devDependencies: adapter-cloudflare, esbuild, SvelteKit 3
  src/objects.ts           Durable Object classes: Notes, Counter
  src/cloudflare.d.ts      types for the cloudflare:workers bindings (svelte-check)
  src/lib/note.ts          note validation, shared by the action and the object
  src/lib/server/objects.ts  callObject() helper around env.OBJECTS.call
  src/routes/+page.server.ts load + form action
  src/routes/+page.svelte    page
  src/routes/api/notes/+server.ts   GET /api/notes
```

## Setup from scratch

1. Scaffold (run inside `sites/`; if `bunx` fails to resolve the current directory, use `npx`):
   ```sh
   npx sv@latest create sveltekit --template minimal --types ts --no-add-ons --install npm
   cd sveltekit
   npm uninstall @sveltejs/adapter-auto
   npm install -D @sveltejs/adapter-cloudflare esbuild
   ```
   `esbuild` is required: `tools/pack.mjs` bundles the worker with it.

2. `vite.config.ts`: the adapter goes into the `sveltekit()` plugin options.
   SvelteKit 3 has no `svelte.config.js`.
   ```ts
   import adapter from '@sveltejs/adapter-cloudflare';
   import { sveltekit } from '@sveltejs/kit/vite';
   import { defineConfig } from 'vite';

   export default defineConfig({
   	plugins: [sveltekit({ adapter: adapter() })]
   });
   ```
   The scaffold also sets runes mode in this file; keep it.

3. `celld.json`: name the outputs explicitly, even though the adapter layout is
   the default. Paths are relative to the site directory.
   ```json
   {
   	"worker": ".svelte-kit/cloudflare/_worker.js",
   	"assets": ".svelte-kit/cloudflare",
   	"objects": "src/objects.ts",
   	"immutable": ["_app/immutable/"],
   	"notFound": "none",
   	"exclude": []
   }
   ```
   `pack.mjs` skips the adapter's server files (`_worker.js`, `_routes.json`,
   `_headers`, `404.html` is still served) and bundles `_worker.js`
   together with `objects.ts` into one module.

4. Bindings types, `src/cloudflare.d.ts`: declare the `cloudflare:workers`
   module (the same file as `sites/example/src/cloudflare.d.ts`). Without it
   `svelte-check` cannot resolve `env` or `DurableObject`.

5. Build, deploy, test:
   ```sh
   npm run build                                          # or let deploy.sh run it
   node tools/pack.mjs sites/sveltekit | wc -c            # must stay under 10 MB
   tools/deploy.sh sites/sveltekit sveltekit.test
   docker compose exec celld curl -s -H 'Host: sveltekit.test' http://127.0.0.1:8080/
   ```

## Durable Objects

`src/objects.ts` exports the classes. Each `(className, name)` pair is its own
SQLite database, and data survives redeploys (verified below).

```ts
export class Notes extends DurableObject {
	#ready = false;
	#sql() {
		const sql = this.ctx.storage.sql;
		if (!this.#ready) {
			sql.exec(`CREATE TABLE IF NOT EXISTS notes (
				id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at TEXT NOT NULL)`);
			this.#ready = true;
		}
		return sql;
	}
	add(input: string) { /* validate, INSERT, return { note } or { error } */ }
	list(limit = 50) { /* SELECT ... ORDER BY id DESC LIMIT ?, plus count(*) */ }
}
```

Rules that matter:

- **Plain data only** across `OBJECTS.call`: arguments and return values must be
  structured-cloneable. Return `{ note }` or `{ error }`, not a `Response` or a
  class instance.
- **Create tables lazily** (`CREATE TABLE IF NOT EXISTS`) in each method. The
  object may be created on the first call, so there is no separate init step.
- **Use `?` bindings** for every value. `sql.exec(query, ...bindings)`.
- **Route calls through one helper**, `src/lib/server/objects.ts`:
  `callObject<T>(className, name, method, ...args)` wraps
  `env.OBJECTS.call(...)`. Routes import it; the class and method names live in
  one place per call site.
- **Validate at both ends.** The form action returns `fail(400, …)` for bad
  input, and the object checks again because it is the storage boundary. The
  shared rule lives in `src/lib/note.ts` (plain TypeScript with no imports, so
  it works in both places).
- Objects cannot set alarms, and there is no KV, D1, R2, queue or secret
  binding. The site has no outbound `fetch`.

## Pages, form actions, JSON

- `+page.server.ts` `load` runs on every request. Calls to `OBJECTS` are
  awaited in parallel with `Promise.all`, and the result is returned as page
  data, so the HTML is rendered on the server with the data in it.
- The default action reads `request.formData()`, validates, and calls the
  object. Invalid input returns `fail(400, { error, text })`. The `text` field
  lets the form keep what the user typed.
- `+page.svelte` uses `use:enhance`. Without JavaScript the form is a normal
  POST; with it, SvelteKit posts the action in the background and updates
  `form` in place.
- `src/routes/api/notes/+server.ts` returns the same data as JSON. It uses
  `RequestHandler` from `./$types`.

Origin checks: SvelteKit rejects cross-origin form POSTs with `403`. A POST
with no `Origin` header is rejected too. To test a POST with curl, send
`-H 'Origin: http://<host>'` (the platform's plain-`http://` requests need the
origin to match the host).

Counter note: a `use:enhance` submit re-runs `load` after the action, so a
successful add also counts as one page view. This is the simplest correct
behaviour for a demo; move the counter into a `GET` route if you need to count
only navigations.

## SvelteKit 3 pitfalls

- **`sv create` scaffolds `adapter-auto`.** Replace it with
  `@sveltejs/adapter-cloudflare` (step 1). `adapter-auto` does not produce the
  worker that `celld.json` expects.
- **`$lib` is gone.** Use `#lib/...` (the `imports` map in `package.json` from
  the scaffold) and include the file extension:
  `import { checkNote } from '#lib/note.ts'`.
- **No `platform.env`.** Bindings come from
  `import { env } from 'cloudflare:workers'`.
- **No `svelte.config.js`.** Adapter and compiler options go in `vite.config.ts`.
- **`$types` appear after `svelte-kit sync`.** `npm run build` and the
  `prepare` script run it; `svelte-check` fails until it has run once.
- **Use `npx` for `sv create`** if `bunx` fails to resolve the current directory.
- **Objects import with relative paths.** `src/objects.ts` imports
  `./lib/note.ts` (relative) rather than `#lib/...`. This is the form that is
  verified to bundle; I did not test the `#lib` alias inside the objects module.
- **`pack.mjs` embeds a build-dependent version id.** Two builds of the same
  source gave different `version` values (for example `cb0b56e239dc` and
  `3ca40a58f65a`); the cause was not investigated, and it does not affect
  behaviour.

## Verified

One run on the development VM; your versions, sizes and timings will differ.
Environment: Node 25 and npm 11; framework and adapter versions are pinned in
`package.json` and `package-lock.json`.

Checks run against the node after `tools/deploy.sh sites/sveltekit sveltekit.test`,
final version `<version>`:

| Check | Result |
| --- | --- |
| `npx svelte-check --tsconfig ./tsconfig.json` | 230 files, 0 errors, 0 warnings |
| Payload `node tools/pack.mjs sites/sveltekit \| wc -c` | 435,646 bytes (limit 10 MB), 16 assets, 286,646 bytes of server code |
| `GET /` (SSR) | HTTP 200, 6,601 bytes, the page view count and notes are in the HTML |
| Form action, JSON path (`Accept: application/json`) | `{"type":"success","status":200,…}`; note added |
| Form action, plain HTML POST (`Accept: text/html`) | HTTP 200, re-rendered page |
| Empty note (whitespace only) | HTTP 400, `"A note cannot be empty."` |
| 281 characters | HTTP 400, `"Keep notes to 280 characters or fewer."` |
| 280 characters (boundary) | accepted, HTTP 200 |
| Foreign `Origin: https://evil.example` | HTTP 403, `"Cross-site POST form submissions are forbidden"` |
| POST with no `Origin` | HTTP 403, same message |
| `GET /api/notes` | HTTP 200, `{"notes":[…newest first…],"total":4}` |
| Hashed asset `/_app/immutable/entry/start.BMFZUzSL.js` | HTTP 200, `cache-control: public, immutable, max-age=31536000`, `text/javascript` |
| Counter | 16 → 18 across two page requests (the count goes up by one per `load`) |
| Persistence across redeploy | before: 2 notes, counter 10; redeploy (version `<version>`); after: 2 notes, counter 11 |
| HTML escaping | a note with `<b>` renders as `&lt;b>` |

Not verified:

- In a real browser: `use:enhance` (pending state, error re-render, no-JS
  fallback). Only the server side of those flows was exercised with curl.
- Dev mode (`npm run dev`) and the 1-second CPU limit under load.
- The test host `sveltekit.test` holds the notes and counter from the run.
  There is no delete route; the data lives in the node's Durable Objects.
