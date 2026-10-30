// One router Worker hosting many sites: any build that is a Workers `fetch`
// handler plus static files (SvelteKit, Nuxt/Nitro, TanStack Start, static-only).
// Each site's code lives in KV and runs in its own Dynamic Worker isolate. A
// request's hostname picks the site: an alias if one exists, otherwise the
// hostname itself is the site id. The site id (not the hostname) owns the
// site's versions and Durable Objects, so a site keeps its data under new names.
//   alias:<hostname>            -> site id
//   site:<site>                 -> current version id
//   code:<version>              -> { compatibilityDate, source, files: { path: [sha256, type] },
//                                    immutable: [prefixes], mutable: [paths], notFound },
//                                  metadata { files }  (the file count)
//   blob:<sha256>               -> file bytes, metadata { at }  (shared by every
//                                  version, of any site, that has the file)
//   asset:<version>:<path>      -> file bytes, metadata { type }  (versions uploaded
//                                  before blobs: code has assets: [paths], no files)
//   deploy:<site>:<iso time>    -> version, metadata { assets, sourceBytes }  (history)
//   staged:<site>:<version>     -> ""  (uploaded for that site, not necessarily active)
//   obj:<site>|<class>|<name>   -> "", metadata { id, firstSeen }  (object index)
// Deploying uploads a version piece by piece (the files the router doesn't have
// yet, then the code and file list), then activates it by flipping site:<site>,
// so visitors never see a half-written version. Activating an older version is a
// rollback.
//
// Requests: static files are served first, like Cloudflare's static assets
// (exact path, then <path>/index.html, then <path>.html), straight from KV
// without starting the site's isolate. Everything else goes to the site's
// worker; a static-only site answers 404 (or index.html with notFound "spa").
//
// Sites get three capabilities and nothing else:
//   ASSETS   their own static files
//   OBJECTS  their own Durable Objects. Each (site, class, name) is a SiteObject
//            supervisor that runs the site's class as a facet with its own
//            SQLite database. The hostname is fixed by the router, so a site
//            can never address another site's objects.
//   EGRESS   outbound fetch() to the hosts the operator allowlisted for that
//            site (egress:<site> in KV). Off by default: celld's operator API
//            on 127.0.0.1 has no authentication, and a site that can fetch it
//            could stop the node or reach other sites' objects. The proxy checks
//            every request against the list, refuses IP literals and internal
//            names, and does not follow redirects (the site follows them, so
//            the next hop is checked too). connect() stays unavailable.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Runs in each site isolate before the site's own code, papering over APIs that
// celld 0.6.3 exposes but that throw "not implemented":
//  - console.createTask: libraries that feature-detect it (Nitro's hookable, so
//    every Nuxt site) then fail on every request. Removing it makes them take
//    their fallback path.
//  - process.nextTick: throws in celld. Nuxt/Nitro's process polyfill copies
//    nextTick from the global process object, and h3 then fails per request.
//    It is replaced with a queueMicrotask-based version.
//  - setImmediate: the global works today; a setTimeout-based stand-in is
//    installed only if it ever does not (Nitro prefers an existing global).
// The prelude must not import node:* modules: doing so breaks the site's own
// named imports from them ("does not provide an export named ...").
const PRELUDE = `
try { console.createTask?.("celld"); } catch {
	try { console.createTask = undefined; } catch {}
	if (console.createTask) Object.defineProperty(console, "createTask", { value: undefined, configurable: true, writable: true });
}

const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const replace = (obj, name, value) => {
	try { obj[name] = value; } catch {}
	if (obj[name] !== value) { try { Object.defineProperty(obj, name, { value, configurable: true, writable: true }); } catch {} }
};

if (typeof globalThis.setImmediate !== "function" || throws(() => globalThis.clearImmediate(globalThis.setImmediate(() => {})))) {
	replace(globalThis, "setImmediate", (fn, ...args) => {
		const timer = setTimeout(fn, 0, ...args);
		return { timer, ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
	});
	replace(globalThis, "clearImmediate", (handle) => { if (handle) clearTimeout(handle.timer ?? handle); });
}

const proc = globalThis.process;
if (proc && throws(() => proc.nextTick(() => {}))) {
	replace(proc, "nextTick", (fn, ...args) => queueMicrotask(() => fn(...args)));
}
`;
// The isolate's main module: prelude first (ES modules evaluate imports in
// order), then the site's handler and its Durable Object classes.
// The exported handler wraps the site's own: the site gets a small request
// context with the notifications it may use (waitUntil, abort,
// passThroughOnException) but not the runtime's object graph (ctx.exports,
// ctx.props). Today ctx.exports only reaches the site's own module, but a
// future celld release could add more, and this keeps the site's reach fixed.
const MAIN = `import "./prelude.js";
import * as site from "./worker.js";
import { attach } from "./celld-data.js";
attach(site);
export * from "./worker.js";
export default {
	fetch(request, env, ctx) {
		const safe = {
			waitUntil: (p) => ctx.waitUntil(p),
			passThroughOnException: () => ctx.passThroughOnException(),
		};
		if (typeof ctx.abort === "function") safe.abort = (reason) => ctx.abort(reason);
		return site.default.fetch(request, env, Object.freeze(safe));
	},
};
`;

// Backups. Every exported class gets a reserved `__celldData(op, arg)` method,
// so the admin API can read and rewrite any object's storage without the site's
// help: its SQLite tables (schema and rows) and its key-value storage. Site code
// cannot reach it through OBJECTS (SiteObjects refuses the name). The function
// below runs inside the site isolate: it is serialized into the celld-data.js
// module, so it must not use anything from this file.
function attachData(site) {
	const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"';
	// SQLite's own tables, the runtime's (_cf_*: not readable) and celld's.
	const internal = (name) => /^(sqlite_|_cf_|_litestream_)/i.test(name);
	const SHADOW = ["_data", "_idx", "_content", "_docsize", "_config", "_segments", "_segdir", "_stat", "_node", "_rowid", "_parent"];
	const CREATABLE = /^\s*CREATE\s+(TABLE|VIRTUAL\s+TABLE|(UNIQUE\s+)?INDEX|TRIGGER|(TEMP\s+|TEMPORARY\s+)?VIEW)\b/i;
	const PAGE_BYTES = 1 << 20;
	const PAGE_ROWS = 2000;
	const KV_PAGE = 128;
	const sizeOf = (v) => (v === null ? 1 : typeof v === "string" ? v.length * 2 : v instanceof ArrayBuffer ? v.byteLength : 8);

	function schema(sql) {
		const all = sql
			.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
			.toArray()
			.filter((r) => !internal(r.name));
		const virtual = all.filter((r) => r.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql)).map((r) => r.name);
		// A virtual table (FTS, R*Tree) keeps its index in shadow tables; its rows are
		// dumped through the virtual table itself and rebuild them on restore.
		const shadow = (name) => virtual.some((v) => SHADOW.some((suffix) => name === v + suffix));
		const tables = [];
		const later = [];
		for (const r of all) {
			if (r.type !== "table") {
				later.push(r.sql);
				continue;
			}
			if (shadow(r.name)) continue;
			const info = sql.exec("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?)", r.name).toArray();
			const isVirtual = virtual.includes(r.name);
			const withoutRowid = !isVirtual && /\bWITHOUT\s+ROWID\b/i.test(r.sql);
			const pks = info.filter((c) => c.pk > 0);
			// An INTEGER PRIMARY KEY is the rowid itself; any other rowid table keeps
			// its rowids too, as apps may rely on them.
			const alias = !withoutRowid && pks.length === 1 && String(pks[0].type).toUpperCase() === "INTEGER";
			tables.push({
				name: r.name,
				sql: r.sql,
				columns: info.filter((c) => c.hidden === 0).map((c) => c.name),
				rowid: !withoutRowid && !alias,
				withoutRowid,
			});
		}
		return { tables, later };
	}

	const ops = {
		schema: (storage) => schema(storage.sql),
		rows(storage, { table, columns, rowid, withoutRowid, after }) {
			const cols = columns.map(quote).join(", ");
			// Without a rowid, page by position; otherwise by rowid (stable and fast).
			const cursor = withoutRowid
				? storage.sql.exec(`SELECT ${cols} FROM ${quote(table)} LIMIT -1 OFFSET ?`, after ?? 0)
				: after === null || after === undefined
					? storage.sql.exec(`SELECT rowid, ${cols} FROM ${quote(table)} ORDER BY rowid`)
					: storage.sql.exec(`SELECT rowid, ${cols} FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid`, after);
			const rows = [];
			let bytes = 0;
			let last = null;
			let more = false;
			for (const raw of cursor.raw()) {
				if (rows.length >= PAGE_ROWS || bytes >= PAGE_BYTES) {
					more = true;
					break;
				}
				let row = raw;
				if (!withoutRowid) {
					last = raw[0];
					if (!rowid) row = raw.slice(1);
				}
				for (const v of row) bytes += sizeOf(v);
				rows.push(row);
			}
			const next = more ? (withoutRowid ? (after ?? 0) + rows.length : last) : null;
			return { rows, next };
		},
		async kv(storage, { after }) {
			const options = { limit: KV_PAGE };
			if (after !== null && after !== undefined) options.startAfter = after;
			const entries = [...(await storage.list(options))];
			return { entries, next: entries.length === KV_PAGE ? entries[entries.length - 1][0] : null };
		},
		// Restore: start from nothing, with foreign keys off until `finish` (rows
		// arrive table by table, so a child may come before its parent).
		async reset(storage) {
			await storage.deleteAll();
			storage.sql.exec("PRAGMA foreign_keys = OFF");
			return true;
		},
		create(storage, { sql }) {
			for (const statement of sql) {
				if (!CREATABLE.test(statement)) throw new Error("a backup may only create tables, indexes, triggers and views");
				storage.sql.exec(statement);
			}
			return true;
		},
		insert(storage, { table, columns, rowid, rows }) {
			const names = (rowid ? ["rowid"] : []).concat(columns.map(quote));
			const statement = `INSERT INTO ${quote(table)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
			storage.transactionSync(() => {
				for (const row of rows) storage.sql.exec(statement, ...row);
			});
			return rows.length;
		},
		async put(storage, { entries }) {
			await storage.put(Object.fromEntries(entries));
			return entries.length;
		},
		finish(storage, { sql }) {
			ops.create(storage, { sql });
			storage.sql.exec("PRAGMA foreign_keys = ON");
			return { foreignKeyProblems: storage.sql.exec("PRAGMA foreign_key_check").toArray().length };
		},
	};

	async function data(op, arg) {
		const storage = this.ctx?.storage ?? this.state?.storage;
		if (!storage?.sql) throw new Error("this object's storage is not reachable (its class must keep ctx)");
		if (!Object.hasOwn(ops, op)) throw new Error(`unknown data operation ${op}`);
		return ops[op](storage, arg ?? {});
	}

	for (const [name, value] of Object.entries(site)) {
		if (name === "default" || typeof value !== "function" || !value.prototype) continue;
		try {
			Object.defineProperty(value.prototype, "__celldData", { value: data });
		} catch {}
	}
}
const DATA = `export const attach = ${attachData.toString()};\n`;
/** Methods only the router may call on a site's objects. */
const RESERVED_METHOD = /^__celld/;

/** Deploy checks (POST /__admin/check) run a version with its Durable Objects under
 *  a scratch site id, so they start empty and never touch live data. Such ids can't
 *  collide with a real site: those are hostnames. */
const scratchFor = (site, version) => `~check~${site}~${version}`;
const isScratch = (site) => site.startsWith("~check~");

/** The hosts one site may fetch(), as stored by PUT /__admin/egress. */
/** The real site behind a site id: a deploy check's scratch id belongs to the
 *  site it checks, and gets that site's allowlist. */
const ownerOf = (site) => (isScratch(site) ? site.slice("~check~".length, site.lastIndexOf("~")) : site);

/** Allowlists are read on every site request (to pick the isolate), so they are
 *  cached for a minute per router isolate; PUT/DELETE /egress clear the entry here,
 *  other router isolates pick a change up within that minute. */
const EGRESS_TTL_MS = 60_000;
const egressCache = new Map(); // site -> { allow, tag, until }
async function egressFor(env, site) {
	const owner = ownerOf(site);
	const hit = egressCache.get(owner);
	if (hit && hit.until > Date.now()) return hit;
	const stored = await env.CODE.get(`egress:${owner}`, "json");
	const allow = Array.isArray(stored) ? stored : [];
	// The list is part of the loader key, so a changed list gets a new isolate with
	// the new proxy instead of waiting for the old one to be evicted.
	const tag = allow.length ? `~e${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(allow.join(",")))).slice(0, 32)}` : "";
	const entry = { allow, tag, until: Date.now() + EGRESS_TTL_MS };
	if (egressCache.size > 1000) egressCache.clear();
	egressCache.set(owner, entry);
	return entry;
}
const egressHosts = async (env, site) => (await egressFor(env, site)).allow;

/** Code records of recently used versions (LRU), so a warm request needs no KV
 *  read. Bounded by bytes: the router isolate's heap is limited to 128 MiB and an
 *  EmDash site's code is ~8 MB. Values only, never a promise another request is
 *  waiting on (see loadSite). */
const codes = new Map(); // version -> code record
const CODE_CACHE_BYTES = 24 * 1024 * 1024;
let codeBytes = 0;
const codeSize = (code) => (code.source?.length ?? 0) + 1024;
async function codeFor(env, version) {
	let code = codes.get(version);
	if (code) {
		codes.delete(version); // most recently used goes last
		codes.set(version, code);
		return code;
	}
	code = await env.CODE.get(`code:${version}`, "json");
	const size = codeSize(code);
	if (size <= CODE_CACHE_BYTES / 2 && !codes.has(version)) {
		for (const [v, c] of codes) {
			if (codeBytes + size <= CODE_CACHE_BYTES) break;
			codes.delete(v);
			codeBytes -= codeSize(c);
		}
		codes.set(version, code);
		codeBytes += size;
	}
	return code;
}

/** Load (or reuse) the isolate for one version of a site. The code is read in the
 *  calling request and the loader gets it synchronously: with an async callback,
 *  concurrent first requests waited on the load the first one started, and
 *  celld 0.6.3 dropped their responses (denoland/celld#258), so they hung until
 *  the 504. */
async function loadSite(env, exports, site, version, egress) {
	const { allow, tag } = egress ?? (await egressFor(env, site));
	const code = await codeFor(env, version);
	return env.LOADER.get(`${site}@${version}${tag}`, () => {
		return {
			compatibilityDate: code.compatibilityDate,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: { "main.js": MAIN, "prelude.js": PRELUDE, "celld-data.js": DATA, "worker.js": code.source },
			env: {
				ASSETS: exports.SiteAssets({ props: { version } }),
				// A scratch site has no active version, so its objects run the checked one.
				OBJECTS: exports.SiteObjects({ props: isScratch(site) ? { site, version } : { site } }),
			},
			// No allowlist: fetch() throws. Otherwise the proxy below decides.
			globalOutbound: allow.length ? exports.SiteEgress({ props: { site, allow } }) : null,
			// One second of CPU per request, and a cap on subrequests (Durable
			// Object calls, egress fetches) so one request cannot fan out without
			// bound. Cloudflare's paid limit is 1000; override with a wrangler var.
			limits: { cpuMs: 1000, subRequests: limit(env, "SITE_MAX_SUBREQUESTS", 1000, 10000) },
		};
	});
}

/** Wall-clock limit for a site's response (until its headers). CPU is capped
 *  separately (1 s per request); this catches code that waits forever, which would
 *  otherwise hold the visitor's connection open. Object calls get 80% of it, so the
 *  site can still answer when one of them times out. */
const timeoutMs = (env) => (Number(env.SITE_TIMEOUT_SECS) || 30) * 1000;
const objectTimeoutMs = (env) => Math.round(timeoutMs(env) * 0.8);

/** A positive whole-number wrangler var, clamped to max, or the default. */
function limit(env, name, def, max) {
	const n = Number(env[name]);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
}

/** Requests one site may have in flight (started, not yet answered) in this
 *  router isolate. Per site, so a flooded site gets 503s instead of starving
 *  every other site on the node. Static files never reach the isolate. */
const inflight = new Map(); // site -> number
async function serveWithLimit(request, env, ctx, site, version) {
	const max = limit(env, "SITE_MAX_INFLIGHT", 128, 10000);
	const now = inflight.get(site) ?? 0;
	if (now >= max) {
		return new Response("too many concurrent requests for this site\n", {
			status: 503,
			headers: { "retry-after": "1", "content-type": "text/plain; charset=utf-8" },
		});
	}
	inflight.set(site, now + 1);
	try {
		return await serve(request, env, ctx, site, version);
	} finally {
		const left = (inflight.get(site) ?? 1) - 1;
		if (left <= 0) inflight.delete(site);
		else inflight.set(site, left);
	}
}
class Timeout extends Error {}
async function withTimeout(promise, ms, what) {
	let timer;
	const expired = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Timeout(`${what} did not finish within ${ms / 1000} s`)), ms);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Objects already in the index, so each costs one KV read per router isolate.
 *  Bounded: site code picks object names, so it could otherwise grow forever. */
const indexed = new Set();
const MAX_INDEXED = 10_000;

/** Path prefixes of content-hashed build output: SvelteKit, Nuxt. tools/pack.mjs
 *  adds assets/ (Vite) to the record itself when every file there is hashed; a
 *  code record without "immutable" never treats assets/ as immutable. */
const DEFAULT_IMMUTABLE = ["_app/immutable/", "_nuxt/"];

/** File bytes. Blobs never change and an old-format version's files don't either,
 *  so any file can be cached; small ones are kept in memory (LRU, bounded) per
 *  router isolate, keyed by storage key (so files shared by versions are cached once). */
const ASSET_CACHE_BYTES = 32 * 1024 * 1024;
const ASSET_CACHE_MAX_ENTRY = 1024 * 1024;
const assetCache = new Map(); // storage key -> { value, type }
let assetCacheBytes = 0;

async function readAsset(env, meta, version, path) {
	const blob = meta.files?.[path];
	const key = blob ? `blob:${blob[0]}` : `asset:${version}:${path}`;
	let hit = assetCache.get(key);
	if (hit) {
		assetCache.delete(key); // most recently used goes last
		assetCache.set(key, hit);
	} else {
		const { value, metadata } = await env.CODE.getWithMetadata(key, "arrayBuffer");
		if (value === null) return null;
		hit = { value, type: metadata?.type };
		if (value.byteLength <= ASSET_CACHE_MAX_ENTRY) {
			assetCache.set(key, hit);
			assetCacheBytes += value.byteLength;
			for (const [k, e] of assetCache) {
				if (assetCacheBytes <= ASSET_CACHE_BYTES) break;
				assetCache.delete(k);
				assetCacheBytes -= e.value.byteLength;
			}
		}
	}
	return { value: hit.value, type: (blob ? blob[1] : hit.type) ?? "application/octet-stream" };
}

/** Whether a path gets the 1-year immutable cache: under an immutable prefix and
 *  not one of the exact paths that change between builds. */
const isImmutable = (cache, path) => cache.immutable.some((p) => path.startsWith(p)) && !cache.mutable.includes(path);

/** Strong validator: the content hash, so a file that didn't change between
 *  versions keeps its ETag across deploys. Old-format versions use version:path. */
const etagFor = (meta, version, path) => {
	const blob = meta.files?.[path];
	return blob ? `"${blob[0].slice(0, 32)}"` : `"${version}:${encodeURIComponent(path)}"`;
};

function notModified(request, etag) {
	const header = request?.headers.get("if-none-match");
	if (!header) return false;
	return header.split(",").some((t) => {
		t = t.trim();
		return t === "*" || t === etag || t === `W/${etag}`;
	});
}

/** One static file of a version, or null if it does not exist. `known` means the
 *  caller checked the version's file list, so a matching If-None-Match can be
 *  answered with 304 without reading the file. */
async function assetResponse(env, version, path, meta, { head = false, status = 200, request, known = false } = {}) {
	const headers = { "cache-control": isImmutable(meta, path) ? "public, immutable, max-age=31536000" : "no-cache" };
	if (status === 200) {
		headers.etag = etagFor(meta, version, path);
		if (known && notModified(request, headers.etag)) return new Response(null, { status: 304, headers });
	}
	const file = await readAsset(env, meta, version, path);
	if (file === null) return null;
	if (status === 200 && notModified(request, headers.etag)) return new Response(null, { status: 304, headers });
	headers["content-type"] = safeContentType(file.type);
	headers["content-length"] = String(file.value.byteLength);
	return new Response(head ? null : file.value, { status, headers });
}

/** A stored content type is served as a header only if it is printable ASCII;
 *  an old record with CR/LF or control characters falls back to octet-stream. */
const safeContentType = (t) => (typeof t === "string" && t.length <= 200 && /^[\x20-\x7e]+$/.test(t) ? t : "application/octet-stream");

/** The ASSETS binding handed to each site: serves only that version's files. */
export class SiteAssets extends WorkerEntrypoint {
	async fetch(request) {
		let path;
		try {
			path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		if (badAssetPath(path)) return new Response("Bad path", { status: 400 });
		const { version } = this.ctx.props;
		const meta = await siteMeta(this.env, version);
		if (!meta.legacy && !meta.assets.has(path)) return new Response("Not found", { status: 404 });
		const opts = { head: request.method === "HEAD", request, known: !meta.legacy };
		return (await assetResponse(this.env, version, path, meta, opts)) ?? new Response("Not found", { status: 404 });
	}
}

/** Routing facts per version (file list and options). The code record is read at
 *  most once a minute: re-uploading a version (same content, new storage format)
 *  replaces it, and other router isolates must notice. */
const metas = new Map();
const META_TTL_MS = 60_000;
async function siteMeta(env, version) {
	let meta = metas.get(version);
	if (!meta || meta.until < Date.now()) {
		const code = await env.CODE.get(`code:${version}`, "json");
		const files = code.files ?? null;
		meta = {
			until: Date.now() + META_TTL_MS,
			legacy: !files && !Array.isArray(code.assets), // deployed before file lists existed
			files,
			assets: new Set(files ? Object.keys(files) : (code.assets ?? [])),
			worker: Boolean(code.source),
			immutable: code.immutable ?? DEFAULT_IMMUTABLE,
			mutable: code.mutable ?? [],
			notFound: code.notFound ?? "none",
		};
		if (metas.size > 500) metas.clear();
		metas.set(version, meta);
	}
	return meta;
}

/** The static file a request path maps to, if any: exact, /index.html, .html. */
function assetFor(meta, pathname) {
	let path;
	try {
		path = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return undefined;
	}
	if (badAssetPath(path)) return undefined;
	const candidates = path === "" || path.endsWith("/") ? [`${path}index.html`] : [path, `${path}/index.html`, `${path}.html`];
	return candidates.find((c) => meta.assets.has(c));
}

/** Paths a deploy may store and a request may ask for. Lookups are always exact
 *  matches against a version's file list, so ".." cannot escape anything; refusing
 *  it keeps odd keys out of storage and out of cache keys. */
const badAssetPath = (path) => path.split("/").includes("..") || path.includes("\\");

/** The OBJECTS binding handed to each site: `call(className, name, method, ...args)`
 *  runs an RPC method on that site's object. Arguments and results must be
 *  structured-cloneable (plain data). */
export class SiteObjects extends WorkerEntrypoint {
	async call(className, name, method, ...args) {
		const { site } = this.ctx.props;
		const ident = /^[A-Za-z_$][\w$]*$/;
		if (!ident.test(className) || !ident.test(method) || className.length > 128 || method.length > 128 || typeof name !== "string" || !name || name.length > 200) {
			throw new Error("bad object reference");
		}
		// Names inherited from Object.prototype resolve through the site's exports
		// (`getDurableObjectClass("constructor")` is the DurableObjectState, and
		// `facet["toString"]` is a prototype method). They are never site classes.
		if (FORBIDDEN_NAMES.has(className) || FORBIDDEN_NAMES.has(method) || RESERVED_METHOD.test(method)) throw new Error("bad object reference");
		const key = `${site}|${className}|${name}`;
		// celld KV keys are limited to 512 bytes; a longer key would surface as an
		// internal KV error instead of a bad reference.
		if (new TextEncoder().encode(key).length > 500) throw new Error("bad object reference");
		const version = this.ctx.props.version ?? (await this.env.CODE.get(`site:${site}`));
		// A site deleted while one of its requests was still running.
		if (version === null) throw new Error("site not found");
		// The check deletes its scratch objects through the index, so record them first.
		if (isScratch(site)) await indexObject(this.env, key);
		else if (!indexed.has(key)) {
			await claimObject(this.env, site, key);
			this.ctx.waitUntil(
				indexObject(this.env, key).then(() => {
					if (indexed.size >= MAX_INDEXED) indexed.clear();
					indexed.add(key);
				}),
			);
		}
		const { allow, tag } = await egressFor(this.env, site);
		const call = this.env.SITE_OBJECTS.getByName(key).handle(site, version, tag, allow, className, method, args);
		return withTimeout(call, objectTimeoutMs(this.env), `${className}.${method}`);
	}
}

/** Why a hostname may not be reached, even when it is on an allowlist. Names
 *  only: an allowlisted name can still resolve to a private address (DNS
 *  rebinding), so only allowlist names whose DNS the operator controls. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".test", ".invalid", ".example", ".onion"];
/** A real top-level domain is alphabetic or punycode: `127.1`, `0x7f.1` and
 *  `1.2.3.4.5` are numeric host forms, not names to allowlist. */
const TLD = /^(?:[a-z][a-z0-9-]*|xn--[a-z0-9-]+)$/;
function internalHost(host, adminHost) {
	if (host === adminHost) return "is the admin hostname";
	if (!host.includes(".")) return "is a single-label name";
	if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return "is an IP address";
	const suffix = INTERNAL_SUFFIXES.find((s) => host.endsWith(s));
	if (suffix) return `ends in ${suffix}`;
	if (!TLD.test(host.slice(host.lastIndexOf(".") + 1))) return "has a numeric or invalid top-level domain";
	return null;
}

/** The outbound network handed to a site with an allowlist. fetch() reaches
 *  only the hosts on it, over HTTPS on 443; everything else gets a 403 the site
 *  can read. */
export class SiteEgress extends WorkerEntrypoint {
	async fetch(request) {
		const { site, allow } = this.ctx.props;
		const deny = (why) => new Response(`egress blocked: ${why}\n`, { status: 403 });
		let url;
		try {
			url = new URL(request.url);
		} catch {
			return deny("the request URL is not valid");
		}
		// HTTPS on 443 only. Besides keeping traffic encrypted, this keeps a rebound
		// name (an allowlisted host resolving to 127.0.0.1) away from celld's
		// operator API, which speaks plain HTTP on another port.
		if (url.protocol !== "https:") return deny(`${url.protocol} is not allowed, only https:`);
		if (url.port !== "") return deny(`port ${url.port} is not allowed, only 443`);
		if (!allow.includes(url.hostname)) return deny(`${url.hostname} is not allowlisted for ${site}`);
		const internal = internalHost(url.hostname, this.env.ADMIN_HOST);
		if (internal) return deny(`${url.hostname} ${internal}`);
		try {
			// Manual redirects: the site follows them, so every hop is checked.
			return await fetch(new Request(request, { redirect: "manual" }));
		} catch (e) {
			return new Response(`egress to ${url.hostname} failed: ${String(e?.message ?? e).slice(0, 300)}\n`, { status: 502 });
		}
	}
}

/** Record an object for the dashboard; object names are only hashes in storage. */
async function indexObject(env, key) {
	if ((await env.CODE.get(`obj:${key}`)) !== null) return;
	const id = env.SITE_OBJECTS.idFromName(key).toString();
	await env.CODE.put(`obj:${key}`, "", { metadata: { id, firstSeen: new Date().toISOString() } });
}

/** Claim a new object against the site's quota. Shared by site code and the
 *  admin seeding endpoint so neither route can create databases past the cap. */
async function claimObject(env, site, key) {
	if ((await env.CODE.get(`obj:${key}`)) !== null) return;
	const max = limit(env, "SITE_MAX_OBJECTS", 1000, 1000);
	const allowed = await env.SITE_OBJECTS.getByName(`~quota~|${site}`).claim(site, key, max);
	if (!allowed) throw new Error(`object quota reached for ${site} (${max})`);
}

/** One per (site, class, name): runs the site's class as a facet. */
export class SiteObject extends DurableObject {
	/** Atomically claim a slot in `site`'s object quota. The instance is keyed
	 *  `~quota~|site` (site ids are hostnames, so no site object can collide with
	 *  it), and its SQLite database is the counter. On first use it seeds from the
	 *  existing object index, so objects created before quotas still count. */
	async claim(site, key, max) {
		return this.ctx.blockConcurrencyWhile(async () => {
			const sql = this.ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS claimed (k TEXT PRIMARY KEY)");
			sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
			if (sql.exec("SELECT 1 FROM claimed WHERE k = ?", key).toArray().length) return true;
			if (!sql.exec("SELECT 1 FROM meta WHERE k = 'seeded'").toArray().length) {
				for (const k of await listAll(this.env.CODE, `obj:${site}|`)) sql.exec("INSERT OR IGNORE INTO claimed (k) VALUES (?)", k.name.slice(4));
				sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', ?)", new Date().toISOString());
			}
			const count = sql.exec("SELECT count(*) AS c FROM claimed").toArray()[0].c;
			if (count >= max) return false;
			sql.exec("INSERT INTO claimed (k) VALUES (?)", key);
			return true;
		});
	}

	/** Delete the quota counter of a deleted site. */
	async clear() {
		await this.ctx.storage.deleteAll();
	}

	/** Abort this object's facet without waiting for its next call. Used when a
	 *  site's egress allowlist changes: a facet keeps the outbound network it was
	 *  loaded with, and pending timers would otherwise keep using it. */
	async rearm(className) {
		try {
			this.ctx.facets.abort(className, new Error("egress allowlist changed"));
		} catch {}
		this.version = undefined;
		this.tag = undefined;
	}

	async handle(site, version, tag, allow, className, method, args) {
		const worker = await loadSite(this.env, this.ctx.exports, site, version, { allow, tag });
		// A redeploy and an egress allowlist change both hand the site a different
		// isolate. Data survives (the facet's name selects the database); a running
		// facet must not keep the outbound network it was created with, or removing
		// an allowlist would not stop an app that is already talking to it.
		const redeployed = this.version !== undefined && this.version !== version;
		const egressChanged = this.tag !== undefined && this.tag !== tag;
		if (redeployed || egressChanged) this.ctx.facets.abort(className, new Error(redeployed ? "site redeployed" : "egress allowlist changed"));
		this.version = version;
		this.tag = tag;
		const facet = this.ctx.facets.get(className, () => ({ class: worker.getDurableObjectClass(className) }));
		return facet[method](...args);
	}

	/** Delete this object's data: the site class's facet database, then our own. */
	async destroy(className) {
		this.ctx.facets.delete(className);
		this.version = undefined;
		await this.ctx.storage.deleteAll();
	}
}

/** Names inherited from Object.prototype are never site classes or methods: they
 *  resolve through the exports object (`getDurableObjectClass("constructor")` is
 *  the DurableObjectState) or through the facet's prototype. */
const FORBIDDEN_NAMES = new Set([
	"__proto__",
	"prototype",
	"constructor",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

/** Largest single static file (KV allows 25 MiB per value). */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
/** Largest code upload (bundled server code plus the file list). */
const MAX_CODE_BYTES = 16 * 1024 * 1024;
const VERSION = /^[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Most files in one version. */
const MAX_FILES = 20_000;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** A site id is a hostname; the admin hostname is never a site. */
const hostOk = (env, host) => HOSTNAME.test(host) && host !== env.ADMIN_HOST;
/** Deploy and write endpoints take a site id, not an alias: resolving an alias
 *  would let "deploy for vanity.test" silently change another site. */
const aliasRefusal = async (env, host) => ((await env.CODE.get(`alias:${host}`)) !== null ? fail(409, `${host} is an alias; use its site id instead`) : null);

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, error) => json({ error }, status);

/** True if the request's bearer token hashes (SHA-256) to `expectedHex`. Only the
 *  hashes are deployment vars, so the bucket never stores a usable token. */
async function bearerMatches(request, expectedHex) {
	const auth = request.headers.get("authorization") ?? "";
	if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex) || !auth.startsWith("Bearer ")) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7))));
	const expected = Uint8Array.from(expectedHex.match(/../g), (h) => parseInt(h, 16));
	return crypto.subtle.timingSafeEqual(digest, expected);
}

/** Reject a body before reading it if it is larger than `max` bytes. */
function tooLarge(request, max) {
	const length = Number(request.headers.get("content-length"));
	if (!Number.isFinite(length) || request.headers.get("content-length") === null) return fail(411, "content-length required");
	if (length > max) return fail(413, `body is ${length} bytes, limit ${max}`);
	return null;
}

/** Every key under a prefix, following list cursors. */
async function listAll(kv, prefix) {
	const keys = [];
	let cursor;
	do {
		const page = await kv.list({ prefix, cursor });
		keys.push(...page.keys);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return keys;
}

/** Hostname -> site id, cached briefly so routing costs no extra KV read per request. */
const aliasCache = new Map();
async function siteFor(env, host) {
	const hit = aliasCache.get(host);
	if (hit && hit.until > Date.now()) return hit.site;
	const site = (await env.CODE.get(`alias:${host}`)) ?? host;
	if (aliasCache.size > 1000) aliasCache.clear();
	aliasCache.set(host, { site, until: Date.now() + 5000 });
	return site;
}

// --- Deploy: upload files, upload code, activate -------------------------------

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** PUT /__admin/blob?hash=H  body: the file bytes; H must be their SHA-256. */
async function putBlob(request, env, url) {
	const hash = url.searchParams.get("hash") ?? "";
	if (!SHA256.test(hash)) return fail(400, "bad hash");
	const big = tooLarge(request, MAX_ASSET_BYTES);
	if (big) return big;
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_ASSET_BYTES) return fail(413, "file too large");
	if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== hash) return fail(400, "body does not match hash");
	await env.CODE.put(`blob:${hash}`, bytes, { metadata: { at: Date.now() } });
	return json({ hash, bytes: bytes.byteLength });
}

/** Which of `hashes` are stored. A deploy asks about its own files (usually tens
 *  to hundreds), so each is looked up by key prefix, 16 at a time; only for very
 *  large file sets is one listing of every stored blob cheaper. */
async function storedBlobs(env, hashes) {
	const unique = [...new Set(hashes)];
	if (unique.length > 2000) {
		const all = new Set((await listAll(env.CODE, "blob:")).map((k) => k.name.slice("blob:".length)));
		return new Set(unique.filter((h) => all.has(h)));
	}
	const stored = new Set();
	for (let i = 0; i < unique.length; i += 16) {
		await Promise.all(
			unique.slice(i, i + 16).map(async (h) => {
				const page = await env.CODE.list({ prefix: `blob:${h}`, limit: 1 });
				if (page.keys.some((k) => k.name === `blob:${h}`)) stored.add(h);
			}),
		);
	}
	return stored;
}

/** POST /__admin/blobs/missing  body: JSON array of SHA-256 hashes. Answers { missing }:
 *  the ones a deploy has to upload. */
async function missingBlobs(request, env) {
	const big = tooLarge(request, MAX_CODE_BYTES);
	if (big) return big;
	let hashes;
	try {
		hashes = await request.json();
	} catch {
		return fail(400, "body is not JSON");
	}
	if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && SHA256.test(h))) {
		return fail(400, "body must be a JSON array of SHA-256 hashes");
	}
	const stored = await storedBlobs(env, hashes);
	return json({ missing: [...new Set(hashes)].filter((h) => !stored.has(h)) });
}

/** Two code records are the same version only if every field matches. Used to
 *  make `code:<version>` write-once while still accepting the re-upload of an
 *  unchanged build (push.sh does that on every deploy). */
const canonicalFiles = (files) =>
	JSON.stringify(
		Object.keys(files)
			.sort()
			.map((p) => [p, files[p]]),
	);
const sameCode = (a, b) =>
	a.compatibilityDate === b.compatibilityDate &&
	a.source === b.source &&
	canonicalFiles(a.files) === canonicalFiles(b.files) &&
	(a.immutable ?? DEFAULT_IMMUTABLE).join("\0") === b.immutable.join("\0") &&
	(a.mutable ?? []).join("\0") === b.mutable.join("\0") &&
	(a.notFound ?? "none") === b.notFound;

/** PUT /__admin/code?version=V[&host=H]
 *  body: { compatibilityDate, source, files: { path: [sha256, type] }, immutable, mutable, notFound }.
 *  Refused unless every file's blob was uploaded first. `host` records the version
 *  as staged for H's site, so activation and admin object calls may target it.
 *  A version id is immutable: the same record may be uploaded again (an unchanged
 *  build), a different one is refused, so "version V is live" cannot be changed
 *  after activation without a new id. */
async function putCode(request, env, url) {
	const version = url.searchParams.get("version") ?? "";
	const host = url.searchParams.get("host");
	if (!VERSION.test(version)) return fail(400, "bad version");
	if (host !== null && !hostOk(env, host)) return fail(400, "bad host");
	if (host !== null) {
		const refusal = await aliasRefusal(env, host);
		if (refusal) return refusal;
	}
	const big = tooLarge(request, MAX_CODE_BYTES);
	if (big) return big;
	let body;
	try {
		body = await request.json();
	} catch {
		return fail(400, "body is not JSON");
	}
	const { compatibilityDate, source = "", files, immutable = DEFAULT_IMMUTABLE, mutable = [], notFound = "none", check = "/" } = body;
	const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
	const entries = files && typeof files === "object" && !Array.isArray(files) ? Object.entries(files) : null;
	const valid =
		typeof compatibilityDate === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) &&
		typeof source === "string" &&
		entries !== null &&
		entries.length <= MAX_FILES &&
		entries.every(
			([path, f]) =>
				path &&
				!path.startsWith("/") &&
				!path.includes("\0") &&
				!badAssetPath(path) &&
				new TextEncoder().encode(path).length <= 400 &&
				Array.isArray(f) &&
				f.length === 2 &&
				SHA256.test(f[0]) &&
				typeof f[1] === "string" &&
				f[1].length <= 200 &&
				!/[\r\n]/.test(f[1]),
		) &&
		strings(immutable) &&
		strings(mutable) &&
		(notFound === "none" || notFound === "spa") &&
		(check === false || (typeof check === "string" && check.startsWith("/") && check.length <= 400));
	if (!valid) return fail(400, "bad code record");
	const stored = await storedBlobs(env, entries.map(([, f]) => f[0]));
	const missing = entries.filter(([, f]) => !stored.has(f[0])).map(([path]) => path);
	if (missing.length) return fail(409, `missing ${missing.length} files, e.g. ${missing.slice(0, 3).join(", ")}`);
	const record = { compatibilityDate, source, files, immutable, mutable, notFound, check };
	const existing = await env.CODE.get(`code:${version}`, "json");
	// A version stored before content-addressed files has no file list; replacing
	// that record with the blob format is the documented upgrade path. A legacy
	// version that is live is not rewritten in place (that would swap the code of
	// an approved version); it needs a new version id.
	const upgrade = existing !== null && existing.files === undefined;
	if (upgrade) {
		for (const k of await listAll(env.CODE, "site:")) {
			if ((await env.CODE.get(k.name)) === version) return fail(409, `version ${version} is live; deploy it in the blob format as a new version instead`);
		}
	}
	if (existing !== null && !upgrade && !sameCode(existing, record)) {
		return fail(409, `version ${version} already exists with different content; build again for a new id`);
	}
	const site = host === null ? null : await siteFor(env, host);
	if (site !== null && !(await canStage(env, site, version))) return fail(429, `at most ${MAX_STAGED} staged versions per site; activate or delete one first`);
	if (existing === null || upgrade) {
		await env.CODE.put(`code:${version}`, JSON.stringify(record), { metadata: { files: entries.length } });
		metas.delete(version);
		codes.delete(version);
	} else if ((existing.check ?? "/") !== check) {
		// `check` is deploy metadata, not part of the version id: editing only that
		// in celld.json must not force a new build. The code fields stay immutable.
		await env.CODE.put(`code:${version}`, JSON.stringify(record), { metadata: { files: entries.length } });
	}
	if (site !== null) await env.CODE.put(`staged:${site}:${version}`, "", { metadata: { at: Date.now() } });
	return json({ version, files: entries.length, sourceBytes: source.length, ...(site !== null && { site }), ...(existing !== null && !upgrade && { unchanged: true }) });
}

/** Staged versions kept per site: enough for a deploy in flight and a manual
 *  binding, without letting a control plane fill the bucket with staging records. */
const MAX_STAGED = 20;

/** Whether another staged version may be added (idempotent for one already staged). */
async function canStage(env, site, version) {
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return true;
	const page = await env.CODE.list({ prefix: `staged:${site}:`, limit: MAX_STAGED });
	return page.keys.length < MAX_STAGED;
}

/** POST /__admin/stage?host=H&version=V  records an already-uploaded version as
 *  built for H's site, so it may be activated for it. PUT /code?host= also stages;
 *  this is for a control plane that uploads first and binds the site later. */
async function stageVersion(env, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	if ((await env.CODE.get(`code:${version}`)) === null) return fail(404, `version ${version} is not uploaded`);
	const site = await siteFor(env, host);
	if (!(await canStage(env, site, version))) return fail(429, `at most ${MAX_STAGED} staged versions per site; activate or delete one first`);
	await env.CODE.put(`staged:${site}:${version}`, "", { metadata: { at: Date.now() } });
	return json({ host, site, version });
}

/** Whether `version` may run as `site`: it was staged for it (PUT /code?host= or
 *  POST /stage), it is in its deploy history (rollback), or it is active now. */
async function versionForSite(env, site, version) {
	if ((await env.CODE.get(`site:${site}`)) === version) return true;
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return true;
	for (const k of await listAll(env.CODE, `deploy:${site}:`)) if ((await env.CODE.get(k.name)) === version) return true;
	return false;
}

/** POST /__admin/activate?host=H&version=V[&ifNew=1]  points H's site at a version
 *  uploaded for it (a new deploy, or a rollback to an older one). With ifNew, a
 *  site that already has an active version is left alone (bundled sites on node
 *  start). A version built for another site is refused: running it here would run
 *  that site's code against this site's Durable Objects. */
async function activate(env, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	const code = await env.CODE.get(`code:${version}`, "json");
	if (!code) return fail(404, `version ${version} is not uploaded (or was pruned)`);
	const site = await siteFor(env, host);
	if (url.searchParams.get("ifNew") === "1") {
		const current = await env.CODE.get(`site:${site}`);
		if (current !== null) return json({ host, site, version: current, skipped: true });
	}
	if (!(await versionForSite(env, site, version))) {
		return fail(409, `version ${version} was not uploaded for ${site} (use PUT /code?host=${site} or POST /stage)`);
	}
	const previous = await env.CODE.get(`site:${site}`);
	const summary = { assets: code.files ? Object.keys(code.files).length : (code.assets?.length ?? 0), sourceBytes: code.source?.length ?? 0 };
	// History first, then the switch: KV has no transactions, and a crash between the
	// two then leaves a history entry for a version that never went live (harmless:
	// prune keeps one version more) rather than a live version prune can't see in
	// the history. The suffix keeps two activations in the same millisecond apart.
	await env.CODE.put(`deploy:${site}:${new Date().toISOString()}~${crypto.randomUUID().slice(0, 8)}`, version, { metadata: summary });
	await env.CODE.put(`site:${site}`, version); // the switch
	// The deploy is done: the staging hint has served its purpose (the version is
	// now in the history, which is what rollback and seeding check).
	await env.CODE.delete(`staged:${site}:${version}`);
	return json({ host, site, version, previous, ...summary });
}

// --- Deploy check ---------------------------------------------------------------

/** POST /__admin/check?host=H&version=V  runs an uploaded version the way it would
 *  serve H, without activating it, and requests its check path (celld.json "check",
 *  default "/"; false skips the check). Its Durable Objects live in a scratch
 *  namespace: they start empty, so the version's migrations run on fresh databases,
 *  and are deleted afterwards. Answers { ok, status, ms, path[, error] }; ok means a
 *  response started within the time limit with a status below 500. Problems that
 *  only appear with real data are for the deploy to catch after activation. */
async function check(env, ctx, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	const code = await env.CODE.get(`code:${version}`, "json");
	if (!code) return fail(404, `version ${version} is not uploaded`);
	const site = await siteFor(env, host);
	if (!(await versionForSite(env, site, version))) {
		return fail(409, `version ${version} was not uploaded for ${site} (use PUT /code?host=${site} or POST /stage)`);
	}
	const path = code.check === false ? null : (code.check ?? "/");
	if (path === null) return json({ ok: true, skipped: true });
	const scratch = scratchFor(site, version);
	// A path that exists as a static file never reaches the worker, so a broken
	// worker would pass. Probe an unknown path too when the site has one; a 404 is
	// fine (it still ran the handler), a 5xx is not.
	const paths = [path];
	const meta = await siteMeta(env, version);
	let staticCheck = false;
	try {
		staticCheck = Boolean(assetFor(meta, new URL(`https://${host}${path}`).pathname));
	} catch {}
	if (path === "/" && meta.worker && staticCheck) paths.push(`/~check-${version}`);
	const started = Date.now();
	let status = 0;
	let error;
	let failed = null;
	for (const p of paths) {
		const request = new Request(`https://${host}${p}`, { headers: { accept: "text/html", "user-agent": "celld-sites deploy check" } });
		try {
			const res = await serveWithLimit(request, env, ctx, scratch, version);
			status = res.status;
			if (status >= 500) {
				failed = { path: p, status, error: (await res.text()).slice(0, 500) };
				break;
			}
			await res.body?.cancel();
		} catch (e) {
			failed = { path: p, status: 500, error: String(e?.message ?? e).slice(0, 500) };
			break;
		}
	}
	const ms = Date.now() - started;
	const cleanup = [];
	for (const k of await listAll(env.CODE, `obj:${scratch}|`)) {
		const key = k.name.slice("obj:".length);
		try {
			await env.SITE_OBJECTS.getByName(key).destroy(key.split("|")[1]);
			await env.CODE.delete(k.name);
		} catch (e) {
			const message = `${key}: ${String(e?.message ?? e).slice(0, 200)}`;
			console.warn(`deploy check cleanup failed: ${message}`);
			cleanup.push(message);
		}
	}
	return json({
		ok: failed === null,
		status: failed?.status ?? status,
		ms,
		path: failed?.path ?? path,
		...(failed?.error !== undefined && { error: failed.error }),
		...(cleanup.length && { cleanup }),
	});
}

// --- Aliases -----------------------------------------------------------------

/** PUT /__admin/alias?host=H&site=S serves site S under hostname H as well (same
 *  versions, same objects). DELETE /__admin/alias?host=H removes it. */
async function alias(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!HOSTNAME.test(host) || host === env.ADMIN_HOST) return fail(400, "bad host");
	if (request.method === "DELETE") {
		await env.CODE.delete(`alias:${host}`);
		aliasCache.delete(host);
		return json({ host, alias: null });
	}
	const site = url.searchParams.get("site") ?? "";
	if (!HOSTNAME.test(site)) return fail(400, "bad site");
	if (site === host) return fail(400, "a hostname already serves the site with its own name");
	if ((await env.CODE.get(`site:${site}`)) === null) return fail(404, `no site ${site}`);
	// Don't silently hide a hostname that is itself a deployed site.
	if ((await env.CODE.get(`site:${host}`)) !== null) return fail(409, `${host} is a site of its own; it would be hidden`);
	await env.CODE.put(`alias:${host}`, site);
	aliasCache.delete(host);
	return json({ host, site });
}

// --- Pruning -------------------------------------------------------------------

/** Blobs no version uses may belong to a deploy in progress (uploaded, code not
 *  yet), or one that failed; they are deleted once they are this old. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;
/** Deploy history entries kept per site. */
const MAX_HISTORY = 100;

/** POST /__admin/prune?confirm=prune&keep=N[&orphanAge=S][&stagedAge=S] deletes
 *  stored versions except each site's current version, the N most recent versions
 *  in its deploy history (default 3), and versions staged for a deploy younger
 *  than stagedAge (default 3). Then it deletes the files no remaining version uses
 *  (blobs after an hour, or orphanAge seconds), history beyond the last 100 deploys
 *  per site, and index and staging records of things that are gone. Destructive and
 *  node-wide, so it needs confirm=prune; the numbers must be whole. */
async function prune(env, url) {
	if (url.searchParams.get("confirm") !== "prune") {
		return fail(400, "prune deletes versions and history; add confirm=prune");
	}
	const keepParam = url.searchParams.get("keep");
	const orphanParam = url.searchParams.get("orphanAge");
	const stagedParam = url.searchParams.get("stagedAge");
	if (keepParam !== null && !/^\d+$/.test(keepParam)) return fail(400, "keep must be a whole number");
	if (orphanParam !== null && !/^\d+$/.test(orphanParam)) return fail(400, "orphanAge must be a whole number");
	if (stagedParam !== null && !/^\d+$/.test(stagedParam)) return fail(400, "stagedAge must be a whole number");
	const keep = Math.max(0, Math.min(100, Number(keepParam ?? 3)));
	const orphanAge = orphanParam !== null ? Number(orphanParam) * 1000 : ORPHAN_AGE_MS;
	const stagedAge = stagedParam !== null ? Number(stagedParam) * 1000 : ORPHAN_AGE_MS;
	const [siteKeys, deployKeys, codeKeys, stagedKeys, objKeys] = await Promise.all(
		["site:", "deploy:", "code:", "staged:", "obj:"].map((p) => listAll(env.CODE, p)),
	);
	const sites = new Set(siteKeys.map((k) => k.name.slice("site:".length)));
	const kept = new Set();
	for (const k of siteKeys) kept.add(await env.CODE.get(k.name));
	const history = new Map(); // site -> [{ at, key }]
	for (const k of deployKeys) {
		const rest = k.name.slice("deploy:".length);
		const site = rest.slice(0, rest.indexOf(":")); // site ids are hostnames: no ":"
		const list = history.get(site) ?? [];
		list.push({ at: rest.slice(site.length + 1), key: k.name });
		history.set(site, list);
	}
	let historyDeleted = 0;
	for (const list of history.values()) {
		list.sort((a, b) => b.at.localeCompare(a.at));
		const recent = [];
		for (const entry of list) {
			if (recent.length >= keep) break;
			const version = await env.CODE.get(entry.key);
			if (!recent.includes(version)) recent.push(version);
		}
		recent.forEach((v) => kept.add(v));
		for (const entry of list.slice(MAX_HISTORY)) {
			await env.CODE.delete(entry.key);
			historyDeleted++;
		}
	}
	// A version staged for a deploy that has not activated yet must survive the
	// prune, or the deploy fails at activation. A staging record without metadata
	// (written by a router before this existed) is treated as fresh once.
	const now = Date.now();
	for (const k of stagedKeys) {
		const version = k.name.slice(k.name.lastIndexOf(":") + 1);
		if (now - (k.metadata?.at ?? now) < stagedAge) kept.add(version);
	}
	const deleted = [];
	const remaining = new Set();
	const used = new Set(); // blob hashes of remaining versions
	const oldFormat = new Set(); // remaining versions whose files are asset: keys
	for (const k of codeKeys) {
		const version = k.name.slice("code:".length);
		if (kept.has(version)) {
			remaining.add(version);
			const code = await env.CODE.get(k.name, "json");
			if (code?.files) for (const [hash] of Object.values(code.files)) used.add(hash);
			else oldFormat.add(version);
			continue;
		}
		await env.CODE.delete(k.name);
		metas.delete(version);
		deleted.push(version);
	}
	// Mark and sweep: blobs no remaining version uses (once old enough, see above).
	let blobsDeleted = 0;
	for (const b of await listAll(env.CODE, "blob:")) {
		if (used.has(b.name.slice("blob:".length)) || now - (b.metadata?.at ?? 0) < orphanAge) continue;
		await env.CODE.delete(b.name);
		blobsDeleted++;
	}
	// Old-format files, unless their version is still stored in that format. (A
	// version re-uploaded with the same content now uses blobs.) Nothing writes
	// asset: keys any more, so no deploy can be in progress for them.
	let oldFilesDeleted = 0;
	for (const a of await listAll(env.CODE, "asset:")) {
		if (oldFormat.has(a.name.slice("asset:".length, "asset:".length + 12))) continue;
		await env.CODE.delete(a.name);
		oldFilesDeleted++;
	}
	// Staging records of versions that no longer exist (version ids have no ":").
	for (const k of stagedKeys) if (!remaining.has(k.name.slice(k.name.lastIndexOf(":") + 1))) await env.CODE.delete(k.name);
	// Index entries of deleted sites.
	for (const k of objKeys) {
		const site = k.name.slice("obj:".length, k.name.indexOf("|"));
		if (!sites.has(site)) await env.CODE.delete(k.name);
	}
	return json({ keep, kept: [...kept].filter(Boolean), deleted, blobsDeleted, oldFilesDeleted, historyDeleted });
}

// --- Deleting a site ---------------------------------------------------------------

/** DELETE /__admin/site?id=S&confirm=S[&aliases=delete] deletes a site: it stops
 *  serving at once, then its Durable Objects' data, deploy history, staging records
 *  and (only with aliases=delete) the aliases pointing at it are deleted. Its
 *  versions stay until the next prune (identical builds share a version). Objects
 *  missing from the index (created before it existed) can't be found by name and
 *  are counted in the dashboard as "not in the index". */
async function deleteSite(env, url) {
	const id = url.searchParams.get("id") ?? "";
	if (!HOSTNAME.test(id)) return fail(400, "bad site id");
	if (url.searchParams.get("confirm") !== id) return fail(400, "confirm must repeat the site id");
	if ((await env.CODE.get(`alias:${id}`)) !== null) return fail(409, `${id} is an alias, not a site id; DELETE /alias removes it`);
	if ((await env.CODE.get(`site:${id}`)) === null) return fail(404, `no site ${id}`);
	const aliasKeys = [];
	for (const k of await listAll(env.CODE, "alias:")) if ((await env.CODE.get(k.name)) === id) aliasKeys.push(k.name);
	if (aliasKeys.length && url.searchParams.get("aliases") !== "delete") {
		return fail(409, `aliases point at ${id}: ${aliasKeys.map((k) => k.slice(6)).join(", ")} (add aliases=delete)`);
	}
	// Stop serving first, so no new request recreates an object while we delete.
	await env.CODE.delete(`site:${id}`);
	metas.clear();
	for (const k of aliasKeys) {
		await env.CODE.delete(k);
		aliasCache.delete(k.slice(6));
	}
	aliasCache.delete(id);
	const objects = [];
	const errors = [];
	for (const k of await listAll(env.CODE, `obj:${id}|`)) {
		const key = k.name.slice("obj:".length);
		const className = key.split("|")[1];
		try {
			await env.SITE_OBJECTS.getByName(key).destroy(className);
			await env.CODE.delete(k.name);
			indexed.delete(key);
			objects.push(key.slice(id.length + 1));
		} catch (e) {
			errors.push(`${key}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
	let history = 0;
	for (const k of await listAll(env.CODE, `deploy:${id}:`)) {
		await env.CODE.delete(k.name);
		history++;
	}
	for (const k of await listAll(env.CODE, `staged:${id}:`)) await env.CODE.delete(k.name);
	await env.CODE.delete(`egress:${id}`);
	egressCache.delete(id);
	try {
		await env.SITE_OBJECTS.getByName(`~quota~|${id}`).clear();
	} catch (e) {
		errors.push(`quota: ${String(e?.message ?? e).slice(0, 200)}`);
	}
	const result = { id, aliases: aliasKeys.map((k) => k.slice(6)), objects: objects.length, history, errors };
	return errors.length ? json(result, 500) : json(result);
}

// --- Calling objects (seeding, exporting) ------------------------------------------

/** Largest argument payload for an admin object call. */
const MAX_CALL_BYTES = 8 * 1024 * 1024;

/** Why an admin call may not run `version` on the site's objects, or null if it may.
 *  Only the active version touches live data: any other version's code (and its
 *  constructor migrations) would run against the data the live version is using, and
 *  swap the class under it. A site that is not live yet may be seeded with a
 *  version staged for it (PUT /code?host=), or one from its history. */
async function callRefusal(env, site, version) {
	const active = await env.CODE.get(`site:${site}`);
	if (active === version) return null;
	if (active !== null) {
		return `${site} is live with version ${active}; seeding another version would run its code on live data (activate it first)`;
	}
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return null;
	for (const k of await listAll(env.CODE, `deploy:${site}:`)) if ((await env.CODE.get(k.name)) === version) return null;
	return `version ${version} was not uploaded for ${site}`;
}

/** POST /__admin/call?host=H&class=C&name=N&method=M[&version=V]  body: JSON array of args.
 *  Runs a method on one of H's site's Durable Objects and returns { result }. This is
 *  how data is seeded or exported: site code has no secrets, so it cannot guard such
 *  routes itself. `version` seeds a site that is not live yet with a version staged
 *  for it (see callRefusal). */
async function adminCall(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	const className = url.searchParams.get("class") ?? "";
	const name = url.searchParams.get("name") ?? "";
	const method = url.searchParams.get("method") ?? "";
	const ident = /^[A-Za-z_$][\w$]*$/;
	if (!hostOk(env, host) || !ident.test(className) || !ident.test(method) || !name || name.length > 200) {
		return fail(400, "need host, class, name and method");
	}
	if (RESERVED_METHOD.test(method)) return fail(400, `${method} is reserved; use /__admin/dump and /__admin/restore`);
	const big = tooLarge(request, MAX_CALL_BYTES);
	if (big) return big;
	let args;
	try {
		const text = await request.text();
		args = text.trim() ? JSON.parse(text) : [];
	} catch {
		return fail(400, "body must be a JSON array of arguments");
	}
	if (!Array.isArray(args)) return fail(400, "body must be a JSON array of arguments");
	const site = await siteFor(env, host);
	const version = url.searchParams.get("version") ?? (await env.CODE.get(`site:${site}`));
	if (!version || !VERSION.test(version)) return fail(404, `no site for ${host}`);
	if ((await env.CODE.get(`code:${version}`)) === null) return fail(404, `version ${version} is not uploaded`);
	const refusal = await callRefusal(env, site, version);
	if (refusal) return fail(409, refusal);
	const key = `${site}|${className}|${name}`;
	if (new TextEncoder().encode(key).length > 500) return fail(400, "bad object reference");
	try {
		await claimObject(env, site, key);
	} catch (e) {
		if (/object quota/.test(String(e?.message ?? e))) return fail(429, e.message);
		throw e;
	}
	await indexObject(env, key);
	try {
		const { allow, tag } = await egressFor(env, site);
		const call = env.SITE_OBJECTS.getByName(key).handle(site, version, tag, allow, className, method, args);
		const result = await withTimeout(call, objectTimeoutMs(env), `${className}.${method}`);
		return json({ site, className, name, method, result: result ?? null });
	} catch (e) {
		if (e instanceof Timeout) return fail(504, e.message);
		if (/object quota/.test(String(e?.message ?? e))) return fail(429, e.message);
		return fail(500, `${className}.${method}: ${String(e?.message ?? e).slice(0, 500)}`);
	}
}

// --- Backups: dump and restore a site's objects --------------------------------------

/** A stored value as JSON. Storage values are structured-clone values (dates,
 *  bytes, maps...) and SQLite cells are null, numbers, text or bytes; anything
 *  JSON can't say is a tagged object `{ "$": tag, ... }`, and a plain object
 *  that has a "$" key of its own is wrapped so it can't be mistaken for one. */
function encodeValue(value, seen = new Set()) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : { $: "num", v: String(value) };
	if (value === undefined) return { $: "undef" };
	if (typeof value === "bigint") return { $: "big", v: value.toString() };
	if (typeof value !== "object") throw new Error(`a ${typeof value} cannot be backed up`);
	if (value instanceof ArrayBuffer) return { $: "bytes", v: base64(new Uint8Array(value)) };
	if (ArrayBuffer.isView(value)) return { $: "view", t: value.constructor.name, v: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
	if (value instanceof Date) return { $: "date", v: Number.isNaN(value.getTime()) ? null : value.toISOString() };
	if (value instanceof RegExp) return { $: "re", v: value.source, f: value.flags };
	if (seen.has(value)) throw new Error("a value that refers to itself cannot be backed up");
	seen.add(value);
	try {
		if (value instanceof Map) return { $: "map", v: [...value].map(([k, v]) => [encodeValue(k, seen), encodeValue(v, seen)]) };
		if (value instanceof Set) return { $: "set", v: [...value].map((v) => encodeValue(v, seen)) };
		if (value instanceof Error) return { $: "err", n: value.name, v: value.message };
		if (Array.isArray(value)) return Array.from(value, (v) => encodeValue(v, seen));
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v, seen);
		return Object.hasOwn(value, "$") ? { $: "obj", v: out } : out;
	} finally {
		seen.delete(value);
	}
}

const VIEWS = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };

function decodeValue(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(decodeValue);
	if (!Object.hasOwn(value, "$")) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));
	switch (value.$) {
		case "num":
			return Number(value.v);
		case "undef":
			return undefined;
		case "big":
			return BigInt(value.v);
		case "bytes":
			return unbase64(value.v).buffer;
		case "view": {
			const View = VIEWS[value.t];
			if (!View) throw new Error(`unknown view type ${value.t}`);
			const bytes = unbase64(value.v);
			return View === DataView ? new DataView(bytes.buffer) : new View(bytes.buffer, 0, bytes.byteLength / View.BYTES_PER_ELEMENT);
		}
		case "date":
			return new Date(value.v ?? NaN);
		case "re":
			return new RegExp(value.v, value.f);
		case "map":
			return new Map(value.v.map(([k, v]) => [decodeValue(k), decodeValue(v)]));
		case "set":
			return new Set(value.v.map(decodeValue));
		case "err":
			return Object.assign(new Error(value.v), { name: value.n });
		case "obj":
			return Object.fromEntries(Object.entries(value.v).map(([k, v]) => [k, decodeValue(v)]));
		default:
			throw new Error(`unknown value tag ${value.$}`);
	}
}

function base64(bytes) {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
const unbase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The site behind `host` and its live version, or an error response. */
async function liveSite(env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!hostOk(env, host)) return { error: fail(400, "bad host") };
	const site = await siteFor(env, host);
	const version = await env.CODE.get(`site:${site}`);
	if (!version) return { error: fail(404, `no site for ${host}`) };
	return { host, site, version };
}

/** Runs one data operation on one of `site`'s objects (see attachData). */
async function objectData(env, site, version, key, className, op, arg) {
	const { allow, tag } = await egressFor(env, site);
	const call = env.SITE_OBJECTS.getByName(key).handle(site, version, tag, allow, className, "__celldData", [op, arg]);
	return withTimeout(call, objectTimeoutMs(env), `${className} ${op}`);
}

/** Splits an indexed object key `site|class|name` (names may contain "|"). */
function splitKey(site, key) {
	const rest = key.slice(site.length + 1);
	const bar = rest.indexOf("|");
	return { className: rest.slice(0, bar), name: rest.slice(bar + 1) };
}

/** GET /__admin/dump?host=H streams a backup of the site's Durable Objects as
 *  JSON lines: a header, then per object its tables (schema, then rows in
 *  pages), its key-value pairs and its indexes/triggers/views, then an "end"
 *  line with totals. A dump without that last line is incomplete (an error line
 *  says why). Objects missing from the index are not found (see deleteSite). */
async function dumpSite(env, ctx, url) {
	const target = await liveSite(env, url);
	if (target.error) return target.error;
	const { site, version } = target;
	const keys = (await listAll(env.CODE, `obj:${site}|`)).map((k) => k.name.slice("obj:".length));
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const line = (o) => writer.write(encoder.encode(`${JSON.stringify(o)}\n`));
	const run = async () => {
		const totals = { objects: 0, rows: 0, keys: 0 };
		try {
			await line({ type: "celld-dump", format: 1, site, version, at: new Date().toISOString(), objects: keys.length });
			for (const key of keys) {
				const { className, name } = splitKey(site, key);
				const data = (op, arg) => objectData(env, site, version, key, className, op, arg);
				const schema = await data("schema");
				await line({ type: "object", class: className, name });
				for (const t of schema.tables) {
					await line({ type: "table", name: t.name, sql: t.sql, columns: t.columns, rowid: t.rowid });
					for (let after = null; ; ) {
						const page = await data("rows", { table: t.name, columns: t.columns, rowid: t.rowid, withoutRowid: t.withoutRowid, after });
						if (page.rows.length) await line({ type: "rows", table: t.name, rows: page.rows.map((row) => row.map((v) => encodeValue(v))) });
						totals.rows += page.rows.length;
						if (page.next === null) break;
						after = page.next;
					}
				}
				for (let after = null; ; ) {
					const page = await data("kv", { after });
					if (page.entries.length) await line({ type: "kv", entries: page.entries.map(([k, v]) => [k, encodeValue(v)]) });
					totals.keys += page.entries.length;
					if (page.next === null) break;
					after = page.next;
				}
				await line({ type: "schema", sql: schema.later });
				totals.objects++;
			}
			await line({ type: "end", ...totals });
		} catch (e) {
			await line({ type: "error", error: String(e?.message ?? e).slice(0, 500) }).catch(() => {});
		} finally {
			await writer.close().catch(() => {});
		}
	};
	ctx.waitUntil(run());
	return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

/** Largest backup POST /__admin/restore reads, and its longest line. */
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;
const MAX_RESTORE_LINE = 64 * 1024 * 1024;

/** The lines of a request body, decoded as JSON, one at a time. */
async function* jsonLines(request) {
	const reader = request.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffered = "";
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_RESTORE_BYTES) throw new Error(`the backup is larger than ${MAX_RESTORE_BYTES} bytes`);
		buffered += value;
		let nl;
		while ((nl = buffered.indexOf("\n")) >= 0) {
			const text = buffered.slice(0, nl);
			buffered = buffered.slice(nl + 1);
			if (text.trim()) yield JSON.parse(text);
		}
		if (buffered.length > MAX_RESTORE_LINE) throw new Error("a line of the backup is too long");
	}
	if (buffered.trim()) yield JSON.parse(buffered);
}

/** POST /__admin/restore?host=H&confirm=H  body: a dump (GET /__admin/dump).
 *  Replaces the site's objects with the backup's: each object in it is emptied
 *  and refilled, and indexed objects that are not in it are deleted. It runs
 *  the site's live version; the objects restart afterwards, so the site's
 *  constructors (and their migrations) run on the restored data. Requests the
 *  site serves meanwhile see a half-restored state, so stop its traffic first.
 *  A backup that turns out incomplete or broken leaves the site part restored
 *  (`changed: true` in the error): restore a good backup to recover. */
async function restoreSite(request, env, url) {
	const target = await liveSite(env, url);
	if (target.error) return target.error;
	const { host, site, version } = target;
	if (url.searchParams.get("confirm") !== host) return fail(400, "confirm must repeat the host");
	if (!request.body) return fail(400, "the body must be a backup (GET /__admin/dump)");
	const ident = /^[A-Za-z_$][\w$]*$/;
	const restored = new Set();
	const totals = { objects: 0, rows: 0, keys: 0 };
	let foreignKeyProblems = 0;
	let changed = false;
	let current = null; // { key, className, tables: Map, finished }
	let ended = null;
	const data = (op, arg) => objectData(env, site, version, current.key, current.className, op, arg);
	try {
		let first = true;
		for await (const line of jsonLines(request)) {
			if (first) {
				if (line?.type !== "celld-dump" || line.format !== 1) throw new Error("this is not a celld backup (format 1)");
				first = false;
				continue;
			}
			if (ended) throw new Error("the backup goes on after its end");
			const need = (cond) => {
				if (!cond) throw new Error(`unexpected "${line?.type}" line in the backup`);
			};
			switch (line?.type) {
				case "object": {
					need(!current || current.finished);
					const className = line.class;
					const name = line.name;
					if (typeof className !== "string" || !ident.test(className) || className.length > 128 || FORBIDDEN_NAMES.has(className)) throw new Error("bad class in the backup");
					if (typeof name !== "string" || !name || name.length > 200) throw new Error("bad object name in the backup");
					const key = `${site}|${className}|${name}`;
					if (new TextEncoder().encode(key).length > 500 || restored.has(key)) throw new Error("bad object in the backup");
					await claimObject(env, site, key);
					await indexObject(env, key);
					current = { key, className, tables: new Map(), finished: false };
					restored.add(key);
					changed = true;
					await data("reset");
					break;
				}
				case "table":
					need(current && !current.finished && typeof line.name === "string" && Array.isArray(line.columns) && typeof line.sql === "string");
					await data("create", { sql: [line.sql] });
					current.tables.set(line.name, { columns: line.columns.map(String), rowid: line.rowid === true });
					break;
				case "rows": {
					need(current && !current.finished && current.tables.has(line.table) && Array.isArray(line.rows));
					const t = current.tables.get(line.table);
					await data("insert", { table: line.table, columns: t.columns, rowid: t.rowid, rows: line.rows.map((row) => row.map(decodeValue)) });
					totals.rows += line.rows.length;
					break;
				}
				case "kv":
					need(current && !current.finished && Array.isArray(line.entries));
					await data("put", { entries: line.entries.map(([k, v]) => [String(k), decodeValue(v)]) });
					totals.keys += line.entries.length;
					break;
				case "schema": {
					need(current && !current.finished && Array.isArray(line.sql));
					const done = await data("finish", { sql: line.sql.map(String) });
					foreignKeyProblems += done.foreignKeyProblems;
					current.finished = true;
					totals.objects++;
					break;
				}
				case "end":
					need(!current || current.finished);
					ended = line;
					break;
				case "error":
					throw new Error(`the backup is incomplete: it failed while being made (${String(line.error).slice(0, 200)})`);
				default:
					need(false);
			}
		}
		if (first) throw new Error("the backup is empty");
		if (!ended) throw new Error("the backup is incomplete (it has no end)");
		if (ended.objects !== totals.objects || ended.rows !== totals.rows || ended.keys !== totals.keys) {
			throw new Error("the backup is incomplete (its totals do not match its contents)");
		}
	} catch (e) {
		const message = String(e?.message ?? e).slice(0, 500);
		if (current) await env.SITE_OBJECTS.getByName(current.key).rearm(current.className).catch(() => {});
		const status = /object quota/.test(message) ? 429 : e instanceof Timeout ? 504 : 422;
		return json({ error: `restore failed: ${message}`, changed }, status);
	}
	// What the backup doesn't have goes: the site ends up exactly as backed up.
	const removed = [];
	const errors = [];
	for (const k of await listAll(env.CODE, `obj:${site}|`)) {
		const key = k.name.slice("obj:".length);
		const { className } = splitKey(site, key);
		try {
			if (restored.has(key)) {
				// Restart it, so the next call runs the site's constructor on the new data.
				await env.SITE_OBJECTS.getByName(key).rearm(className);
			} else {
				await env.SITE_OBJECTS.getByName(key).destroy(className);
				await env.CODE.delete(k.name);
				indexed.delete(key);
				removed.push(key.slice(site.length + 1));
			}
		} catch (e) {
			errors.push(`${key}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
	const result = { site, ...totals, removed: removed.length, foreignKeyProblems, errors };
	return errors.length ? json({ ...result, error: "restored, but some objects could not be cleaned up", changed: true }, 500) : json(result);
}

/** Abort every indexed object of `site`, so a changed egress allowlist reaches
 *  running facets immediately. Objects missing from the index (created before
 *  it existed) are not found; they are also the ones the dashboard reports as
 *  "not in the index". */
async function abortFacets(env, site) {
	const keys = await listAll(env.CODE, `obj:${site}|`);
	for (let i = 0; i < keys.length; i += 16) {
		await Promise.all(
			keys.slice(i, i + 16).map(async (k) => {
				const key = k.name.slice("obj:".length);
				const className = key.slice(site.length + 1, key.indexOf("|", site.length + 1));
				if (!className) return;
				try {
					await env.SITE_OBJECTS.getByName(key).rearm(className);
				} catch {}
			}),
		);
	}
}

/** GET /__admin/egress?host=H: the hosts H's site may fetch().
 *  PUT with a JSON array of hostnames replaces the list; DELETE clears it. */
async function getEgress(env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!HOSTNAME.test(host)) return fail(400, "bad host");
	const site = await siteFor(env, host);
	return json({ host, site, allow: await egressHosts(env, site) });
}

const MAX_EGRESS_HOSTS = 20;
async function putEgress(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!hostOk(env, host)) return fail(400, "bad host");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	// Allowed before the site exists: the store installer grants the declared
	// hosts first, so the deploy check runs with the permissions the app needs.
	const site = await siteFor(env, host);
	let list;
	try {
		list = await request.json();
	} catch {
		return fail(400, "body must be a JSON array of hostnames");
	}
	if (!Array.isArray(list)) return fail(400, "body must be a JSON array of hostnames");
	const allow = [];
	for (const raw of list) {
		if (typeof raw !== "string") return fail(400, "hostnames must be strings");
		const name = raw.trim().toLowerCase();
		if (!HOSTNAME.test(name)) return fail(400, `bad hostname: ${raw}`);
		const internal = internalHost(name, env.ADMIN_HOST);
		if (internal) return fail(400, `${name} ${internal} and cannot be allowlisted`);
		if (!allow.includes(name)) allow.push(name);
	}
	if (allow.length > MAX_EGRESS_HOSTS) return fail(400, `at most ${MAX_EGRESS_HOSTS} hostnames`);
	await env.CODE.put(`egress:${site}`, JSON.stringify(allow));
	egressCache.delete(site);
	// A running facet keeps the outbound network it was loaded with, including
	// pending timers, so it is aborted now rather than on its next call.
	await abortFacets(env, site);
	return json({ host, site, allow });
}

async function deleteEgress(env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!hostOk(env, host)) return fail(400, "bad host");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	const site = await siteFor(env, host);
	await env.CODE.delete(`egress:${site}`);
	egressCache.delete(site);
	await abortFacets(env, site);
	return json({ host, site, allow: [] });
}

// --- Read-only ------------------------------------------------------------------

/** GET /__admin/overview: sites (with aliases), deploy history, versions, object index. */
async function overview(env) {
	const [siteKeys, aliasKeys, deployKeys, objKeys, codeKeys] = await Promise.all(
		["site:", "alias:", "deploy:", "obj:", "code:"].map((p) => listAll(env.CODE, p)),
	);
	const aliases = await Promise.all(aliasKeys.map(async (k) => ({ host: k.name.slice(6), site: await env.CODE.get(k.name) })));
	const sites = await Promise.all(
		siteKeys.map(async (k) => {
			const id = k.name.slice(5);
			return { id, version: await env.CODE.get(k.name), aliases: aliases.filter((a) => a.site === id).map((a) => a.host) };
		}),
	);
	const deploys = await Promise.all(
		deployKeys.map(async (k) => {
			const rest = k.name.slice(7); // <site>:<iso time>~<suffix>
			const at = rest.slice(rest.indexOf(":") + 1).split("~")[0];
			return { site: rest.slice(0, rest.indexOf(":")), at, version: await env.CODE.get(k.name), ...k.metadata };
		}),
	);
	const objects = objKeys.map((k) => {
		const rest = k.name.slice(4);
		const first = rest.indexOf("|");
		const second = rest.indexOf("|", first + 1);
		return { site: rest.slice(0, first), className: rest.slice(first + 1, second), name: rest.slice(second + 1), ...k.metadata };
	});
	const versions = await Promise.all(
		codeKeys.map(async (k) => {
			const version = k.name.slice(5);
			const assets = k.metadata?.files ?? (await listAll(env.CODE, `asset:${version}:`)).length;
			return { version, assets };
		}),
	);
	return json({ sites, aliases, deploys, objects, versions });
}

/** GET /__admin/state: celld's live node counters (the only operator call made).
 *  OPERATOR_URL is the node's internal listener (production pins it to
 *  127.0.0.1:8081); `celld dev` picks a random port, so previews leave it empty. */
async function nodeState(env) {
	if (!env.OPERATOR_URL) return fail(503, "node state is not available here (no OPERATOR_URL; e.g. celld dev)");
	try {
		const res = await fetch(`${env.OPERATOR_URL}/state`, { signal: AbortSignal.timeout(5000) });
		return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
	} catch (e) {
		return fail(502, `node state unreachable: ${String(e?.message ?? e).slice(0, 200)}`);
	}
}

/** The admin API. Writes need the deploy token; the read-only GETs also accept the read token. */
async function admin(request, env, ctx, url) {
	const { pathname } = url;
	const method = request.method;
	const isAdmin = await bearerMatches(request, env.ADMIN_TOKEN_SHA256);
	if (method === "GET" && (pathname === "/__admin/overview" || pathname === "/__admin/state")) {
		if (!isAdmin && !(await bearerMatches(request, env.READ_TOKEN_SHA256))) return fail(403, "forbidden");
		return pathname === "/__admin/overview" ? overview(env) : nodeState(env);
	}
	if (!isAdmin) return fail(403, "forbidden");
	if (method === "PUT" && pathname === "/__admin/blob") return putBlob(request, env, url);
	if (method === "POST" && pathname === "/__admin/blobs/missing") return missingBlobs(request, env);
	if (method === "PUT" && pathname === "/__admin/code") return putCode(request, env, url);
	if (method === "POST" && pathname === "/__admin/activate") return activate(env, url);
	if (method === "POST" && pathname === "/__admin/stage") return stageVersion(env, url);
	if (method === "POST" && pathname === "/__admin/check") return check(env, ctx, url);
	if ((method === "PUT" || method === "DELETE") && pathname === "/__admin/alias") return alias(request, env, url);
	if (method === "POST" && pathname === "/__admin/prune") return prune(env, url);
	if (method === "DELETE" && pathname === "/__admin/site") return deleteSite(env, url);
	if (method === "POST" && pathname === "/__admin/call") return adminCall(request, env, url);
	if (method === "GET" && pathname === "/__admin/dump") return dumpSite(env, ctx, url);
	if (method === "POST" && pathname === "/__admin/restore") return restoreSite(request, env, url);
	if (pathname === "/__admin/egress") {
		if (method === "GET") return getEgress(env, url);
		if (method === "PUT") return putEgress(request, env, url);
		if (method === "DELETE") return deleteEgress(env, url);
	}
	return fail(404, "not found");
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const host = url.hostname;
		// The admin API answers only on an internal hostname that Traefik never
		// routes, so only the project's containers reach it, and every call needs a token.
		if (host === env.ADMIN_HOST) return admin(request, env, ctx, url);

		let site = await siteFor(env, host);
		let version = await env.CODE.get(`site:${site}`);
		// Local previews (tools/preview.sh) set DEFAULT_SITE so the one site answers on
		// any hostname (localhost, an IP); production leaves it empty.
		if (!version && env.DEFAULT_SITE) {
			site = env.DEFAULT_SITE;
			version = await env.CODE.get(`site:${site}`);
		}
		if (!version) return new Response(`No site for ${host}`, { status: 404 });
		// Sites under PROXY_SITE_PREFIX (Hamster grains) belong to a front proxy
		// that authenticates the visitor and sets identity headers. Only that proxy
		// knows the token, so another container on the bridge cannot reach a grain
		// directly or forge its identity headers.
		const proxied = proxyPrefix(env) !== "" && site.startsWith(proxyPrefix(env));
		const supplied = request.headers.get(PROXY_HEADER);
		if (proxied && !(await tokenMatches(supplied, env.PROXY_TOKEN_SHA256))) return new Response(`No site for ${host}`, { status: 404 });
		if (supplied !== null) {
			const headers = new Headers(request.headers);
			headers.delete(PROXY_HEADER);
			request = new Request(request, { headers });
		}
		return serveWithLimit(request, env, ctx, site, version);
	},
};

const PROXY_HEADER = "x-celld-proxy-token";
/** An unreplaced template placeholder (an older preview script) disables the check. */
const proxyPrefix = (env) => (/^[a-z0-9][a-z0-9.-]*$/.test(env.PROXY_SITE_PREFIX ?? "") ? env.PROXY_SITE_PREFIX : "");
async function tokenMatches(token, expectedHex) {
	if (token === null || !expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	const expected = Uint8Array.from(expectedHex.match(/../g), (h) => parseInt(h, 16));
	return crypto.subtle.timingSafeEqual(digest, expected);
}

/** Answer a request with one version of a site: static files first, then its worker. */
async function serve(request, env, ctx, site, version) {
	const url = new URL(request.url);
	const meta = await siteMeta(env, version);
	const head = request.method === "HEAD";
	if (!meta.legacy && (request.method === "GET" || head)) {
		const path = assetFor(meta, url.pathname);
		const res = path && (await assetResponse(env, version, path, meta, { head, request, known: true }));
		if (res) return res;
	}
	if (!meta.legacy && !meta.worker) {
		// Static-only site: optional SPA fallback for page navigations (not for
		// missing scripts or images), then 404.html, then a bare 404.
		const navigation = (request.headers.get("accept") ?? "").includes("text/html");
		if ((request.method === "GET" || head) && navigation && meta.notFound === "spa" && meta.assets.has("index.html")) {
			return assetResponse(env, version, "index.html", meta, { head, request, known: true });
		}
		const notFound = meta.assets.has("404.html") && (await assetResponse(env, version, "404.html", meta, { head, status: 404 }));
		return notFound || new Response("Not found", { status: 404 });
	}

	// Traefik terminates TLS and forwards plain HTTP. Hand sites the URL the
	// browser used, so origins match (SvelteKit's CSRF check, redirects, cookies).
	let siteRequest = request;
	if (url.protocol === "http:" && request.headers.get("x-forwarded-proto") === "https") {
		url.protocol = "https:";
		siteRequest = new Request(url, request);
	}

	// Compiled once per version; later requests reuse the warm isolate.
	try {
		return await withTimeout((await loadSite(env, ctx.exports, site, version)).getEntrypoint().fetch(siteRequest), timeoutMs(env), "the site");
	} catch (e) {
		if (e instanceof Timeout) return new Response(`${e.message}\n`, { status: 504 });
		throw e;
	}
}
