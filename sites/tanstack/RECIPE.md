# TanStack Start on celld-sites

A React / TanStack Start app that runs as a Cloudflare Workers module on
celld-sites: SSR per request, Durable Objects for state, a JSON API route and
hashed static assets. The example is the "notes board" in this directory.

Versions are pinned in this directory's `package.json` and `package-lock.json`:
TanStack Start and Router 1.x, React 19, Vite 8, `@cloudflare/vite-plugin` 1.x,
Node 25.

## 1. Scaffold

```sh
npm install @tanstack/react-start @tanstack/react-router react react-dom
npm install -D @cloudflare/vite-plugin @vitejs/plugin-react vite typescript \
  @types/react @types/react-dom @types/node esbuild wrangler
```

Use `npm`, not `bunx`. The Cloudflare Vite plugin reads `wrangler.jsonc` during
the build; the `wrangler.json` it emits is not used by celld-sites. I kept
`wrangler` in devDependencies because the setup docs list it; I did not test
whether it is required.

## 2. Vite config

`vite.config.ts`: the Cloudflare plugin first, with the `ssr` environment,
then `tanstackStart()`, then `viteReact()`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), viteReact()],
});
```

`wrangler.jsonc` (build-only):

```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "celld-tanstack",
	"main": "@tanstack/react-start/server-entry",
	"compatibility_date": "2026-10-01",
	"compatibility_flags": ["nodejs_compat"]
}
```

Scripts: `"build": "vite build && tsc --noEmit"`. Do not add a `start` script
or `wrangler deploy`; deploy with `tools/deploy.sh`.

The TanStack router needs `src/router.tsx` exporting `getRouter()` and a root
route `src/routes/__root.tsx` with `shellComponent`. The router plugin generates
`src/routeTree.gen.ts` during the build; keep it in the repo.

## 3. Build output and `celld.json`

After `vite build` the layout is:

```
dist/client/assets/index-<hash>.js      client bundle
dist/client/assets/routes-<hash>.js
dist/client/assets/styles-<hash>.css    (linked from the root route via `?url`)
dist/client/.assetsignore               excluded by pack.mjs automatically
dist/server/index.js                    worker entry, `export default { fetch }`
dist/server/assets/*.js                 server chunks (inlined by pack.mjs)
dist/server/wrangler.json               ignored by celld-sites
```

`celld.json`:

```json
{
	"worker": "dist/server/index.js",
	"assets": "dist/client",
	"objects": "src/objects.ts",
	"immutable": ["assets/"],
	"notFound": "none"
}
```

`pack.mjs` bundles `dist/server/index.js` with esbuild and keeps
`cloudflare:workers` and `node:*` external. The bundle exported `Counter`,
`Notes` and `default` (verified).

## 4. Durable Objects (`src/objects.ts`)

```ts
import { DurableObject } from "cloudflare:workers";

export class Notes extends DurableObject {
	#sql() {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at TEXT NOT NULL)");
		return sql;
	}
	add(text: string) {
		this.#sql().exec("INSERT INTO notes (text, at) VALUES (?, ?)", text, new Date().toISOString());
		return this.list();
	}
	list(limit = 50) {
		return this.#sql().exec("SELECT id, text, at FROM notes ORDER BY id DESC LIMIT ?", limit).toArray();
	}
}
```

Arguments and results must be plain data. `Counter.hit()` is the same pattern.

Call them only from server code, through a small helper (`src/server/board.ts`):

```ts
import { env } from "cloudflare:workers";
export const listNotes = () => env.OBJECTS.call("Notes", "main", "list");
```

Keep that module out of client code. The client may import **types** from
`src/objects.ts` (`import type`), not values.

## 5. Server functions and the loader

```ts
import { createServerFn } from "@tanstack/react-start";

export const getBoard = createServerFn({ method: "GET" }).handler(async () => {
	const [views, notes] = await Promise.all([countView(), listNotes()]);
	return { views, notes, renderedAt: new Date().toISOString() };
});

export const addNote = createServerFn({ method: "POST" })
	.validator((input: { text: string }) => ({ text: String(input?.text ?? "") }))
	.handler(async ({ data }) => { /* trim, check 1..280, then env.OBJECTS.call("Notes", ...) */ });
```

Pitfalls:

- In TanStack Start 1.169 the input hook is `.validator(...)`, not
  `.inputValidator(...)` (`tsc` reported the missing property).
- The route loader `loader: () => getBoard()` runs during SSR, so the data is
  in the HTML. The page-view counter is incremented by every loader run. After
  adding a note, update local state from the returned list instead of
  `router.invalidate()`, which would count an extra view.
- Return validation errors as data (`{ ok: false, error }`) rather than
  throwing; the client then shows them without a 500.

## 6. Server route for JSON

`src/routes/api.notes.ts`:

```ts
export const Route = createFileRoute("/api/notes")({
	server: { handlers: { GET: async () => Response.json({ notes: await listNotes() }) } },
});
```

## 7. Pitfalls and how they were solved

1. **`Could not resolve entry for router`**: the build needs `src/router.tsx`
   (`getRouter`) before any route exists.
2. **Server function RPC returned `500 Seroval Error (step: 3)`** when I sent
   `{"data":...,"context":{}}` as plain JSON. The server decodes RPC bodies with
   `fromJSON`, which expects the Seroval envelope `{ "t": <node>, "f": 127, "m": [] }`
   (`toJSON` from the `seroval` package). Step 3 is *deserialization*, so it
   pointed at the request, not at the notes code. Generate the body with
   `toJSON` from the site's own `node_modules/seroval`.
3. **RPC GET without an `Origin` header returns `403 Forbidden`.** Add
   `-H 'Origin: http://<host>'` for all `/_serverFn/` calls.
4. **Server function IDs** are content hashes; find them in
   `dist/server/assets/*.js` (`id: "<64 hex>"`). They change on every build.
5. **`cloudflare:workers` must stay out of client code.** It is only imported
   from server modules; the client bundle was checked and contains no reference.
6. **Build warning** `SOURCEMAP_BROKEN` from `vite:css-post` appears during
   `vite build`. It did not affect the output; I did not look into its cause.

## 8. Testing

```sh
node tools/pack.mjs sites/tanstack | wc -c     # must be < 10 MB
tools/deploy.sh sites/tanstack tanstack.test
docker compose exec celld curl -s -H 'Host: tanstack.test' http://127.0.0.1:8080/
```

RPC from curl (generate the body with `node -e` using the site's `seroval`):

```sh
ID=<id from dist/server/assets>
BODY=$(node -e 'const {toJSON}=require("seroval");process.stdout.write(JSON.stringify(toJSON({data:{text:"hi"},context:{}})))')
docker compose exec celld curl -s -X POST -H 'Host: tanstack.test' \
  -H 'Origin: http://tanstack.test' -H 'Content-Type: application/json' \
  -H 'Accept: application/json' -H 'x-tsr-serverFn: true' \
  --data-binary "$BODY" "http://127.0.0.1:8080/_serverFn/$ID"
```

## Verified

One run on the development VM; versions, sizes and timings will differ.

Deployed with `tools/deploy.sh sites/tanstack tanstack.test`:
`{"host":"tanstack.test","version":"<version>","assets":3,"sourceBytes":<bytes>}`.

- **Payload:** `node tools/pack.mjs sites/tanstack | wc -c` = **1,480,929 bytes**
  (about 1.4 MB, under the 10 MB limit). Server code 985,099 bytes; 3 static assets.
- **SSR page `/`:** `HTTP 200`, `content-type: text/html`. The HTML already
  contains the counter, the notes and the form (no client-side fetch needed).
  Notes added earlier appear in the server-rendered list.
- **Counter across requests:** `page views` rendered `1`, then `2`, `3`, `4`
  over successive GETs.
- **Add note (RPC POST):** `HTTP 200`, result `{ok: true, notes: [...]}` with
  the new note at `id` 1 and `at` set. A note of exactly 280 characters was
  accepted.
- **Validation:** whitespace-only text returned `{ok: false, error: "Write something first."}`;
  281 characters returned `{ok: false, error: "Notes are limited to 280 characters."}`.
  Neither was stored (the list kept only the two valid notes).
- **Origin check:** a POST without `Origin` returned `HTTP 403`.
- **`GET /api/notes`:** `HTTP 200`, `content-type: application/json`,
  body `{"notes":[{"id":2,...},{"id":1,"text":"hello from curl",...}]}`.
- **Hashed assets:** `/assets/index-D89Rm2yC.js` (344,790 bytes) and
  `/assets/styles-D34Mxx7f.css` (1,381 bytes) both return `HTTP 200` with
  `cache-control: public, immutable, max-age=31536000`.

Not verified:

- **Real browser.** The form and hydration were not exercised in a browser. The
  RPC path that the form uses was tested with curl, and the bundle was checked
  for `cloudflare:workers`, but no click-through test was run.
- **Persistence across redeploys.** Not tested. The router documents that
  object data survives redeploys.
- **Load and CPU limits.** Only a few requests were made; the 1-second CPU limit
  was not measured.
