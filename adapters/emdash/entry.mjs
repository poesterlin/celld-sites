// celld-sites entry for an EmDash site (Astro + @astrojs/cloudflare build).
// tools/deploy-emdash.sh copies this directory into the site checkout as
// celld-adapter/ and builds with a config that stores the CMS in the EmDashDB
// Durable Object instead of D1.
//
// A celld site gets only ASSETS and OBJECTS. EmDash and Astro expect a Durable
// Object namespace (DB_DO), an R2 bucket (MEDIA, media uploads) and a KV
// namespace (SESSION, Astro sessions). The objects below implement the part of
// those APIs they use, on top of OBJECTS.call and the classes in objects.mjs.
// EmDash and Astro read `env` from cloudflare:workers when a request needs a
// binding, so adding them to it before the first request is enough.
import { env } from "cloudflare:workers";
import handler from "../dist/server/entry.mjs";

const call = (className, name, method, ...args) => env.OBJECTS.call(className, name, method, ...args);

// DurableObjectNamespace: EmDash calls idFromName(name), then get(id).<method>(...).
// Every method becomes OBJECTS.call; arguments and results are plain data.
const namespace = (className) => ({
	idFromName: (name) => name,
	get: (name) =>
		new Proxy({}, { get: (_, method) => (typeof method === "string" && method !== "then" ? (...args) => call(className, name, method, ...args) : undefined) }),
});

const bytesOf = async (body) => {
	if (body == null) return new Uint8Array();
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return new Uint8Array(await new Response(body).arrayBuffer());
};
const r2Object = (meta, bytes) =>
	meta && {
		key: meta.key,
		size: meta.size,
		etag: meta.etag,
		httpEtag: `"${meta.etag}"`,
		uploaded: new Date(meta.uploaded),
		httpMetadata: { contentType: meta.contentType },
		customMetadata: {},
		...(bytes && {
			body: new Response(bytes).body,
			arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			text: async () => new TextDecoder().decode(bytes),
		}),
	};

// R2Bucket: put/get/head/delete/list, as @emdash-cms/cloudflare/storage/r2 uses them.
const MEDIA = {
	async put(key, body, opts = {}) {
		return r2Object(await call("EmDashMedia", "media", "put", key, await bytesOf(body), opts.httpMetadata?.contentType ?? null));
	},
	async get(key) {
		const found = await call("EmDashMedia", "media", "get", key);
		return found ? r2Object(found.meta, found.bytes) : null;
	},
	async head(key) {
		return r2Object(await call("EmDashMedia", "media", "head", key)) ?? null;
	},
	async delete(keys) {
		await call("EmDashMedia", "media", "delete", [].concat(keys));
	},
	async list(opts = {}) {
		const page = await call("EmDashMedia", "media", "list", opts.prefix ?? "", opts.limit ?? 1000, opts.cursor ?? null);
		return { objects: page.objects.map((m) => r2Object(m)), truncated: page.truncated, cursor: page.cursor, delimitedPrefixes: [] };
	},
};

// KVNamespace: get/put/delete/list, as Astro's cloudflare-kv-binding session driver uses them.
const SESSION = {
	async get(key, type) {
		const value = await call("EmDashKV", "session", "get", key);
		if (value == null) return null;
		return (typeof type === "string" ? type : type?.type) === "json" ? JSON.parse(value) : value;
	},
	async put(key, value, opts = {}) {
		await call("EmDashKV", "session", "put", key, String(value), opts.expirationTtl ?? null);
	},
	async delete(key) {
		await call("EmDashKV", "session", "delete", key);
	},
	async list(opts = {}) {
		const keys = await call("EmDashKV", "session", "list", opts.prefix ?? "");
		return { keys: keys.map((name) => ({ name })), list_complete: true, cacheStatus: null };
	},
};

Object.assign(env, { DB_DO: namespace("EmDashDB"), MEDIA, SESSION });

// One request at a time per isolate. celld 0.6.3 never settles an outbound call
// made from a promise continuation that another request's event resumed
// (denoland/celld#258, #277). EmDash shares in-flight promises between concurrent
// requests (per-isolate caches and init locks), so the ~15 parallel requests its
// admin makes hung until the 30 s 504. Waiting requests poll with their own
// timers: awaiting a promise that the previous request resolves would be that
// same pattern. Measured: a 15-request admin burst takes 0.2-1 s this way.
const POLL_MS = 5;
let busy = false;
async function exclusive(run) {
	while (busy) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	busy = true;
	try {
		const response = await run();
		// Read the body before the next request starts, so no stream outlives its
		// turn. Responses are rendered pages and JSON, not large downloads.
		if (!response.body) return response;
		return new Response(await response.arrayBuffer(), response);
	} finally {
		busy = false;
	}
}

// EmDash 0.36's admin builds a content link from each collection's `urlPattern`,
// but its manifest never sends one: the field is missing from `ManifestResponse`
// (upstream added it in 0.37), so `contentUrl` always falls back to
// /<collection>/<slug> and every page links to /pages/<slug> while the site
// serves /<slug>. Fill the pattern in from the collection row EmDash reads, so
// the admin, the sitemap and the menus agree with the routes.
const MANIFEST_PATH = "/_emdash/api/manifest";
async function withCollectionUrls(response) {
	if (!response.ok) return response;
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return new Response(text, response);
	}
	const collections = body?.data?.collections;
	if (collections) {
		try {
			const { rows } = await call("EmDashDB", "emdash", "query", "SELECT slug, url_pattern FROM _emdash_collections", []);
			const patterns = new Map(rows.map((row) => [row.slug, row.url_pattern]));
			for (const [name, collection] of Object.entries(collections))
				collection.urlPattern ??= patterns.get(name) ?? undefined;
		} catch {
			// Without the pattern the admin works; only the links fall back.
		}
	}
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return Response.json(body, { status: response.status, headers });
}

export default {
	fetch: (request, _env, ctx) =>
		exclusive(async () => {
			const response = await handler.fetch(request, env, ctx);
			return new URL(request.url).pathname === MANIFEST_PATH ? withCollectionUrls(response) : response;
		}),
};
