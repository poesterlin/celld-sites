import { egressFor } from "../egress/cache.ts";
import { fail, json } from "../lib/http.ts";
import { Timeout, objectTimeoutMs, withTimeout } from "../lib/limits.ts";
import { hostOk, siteFor } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";
import { FORBIDDEN_NAMES } from "../objects/names.ts";
import { claimObject, indexObject, indexed } from "../objects/registry.ts";

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
async function objectData(env: any, site: string, version: string, key: string, className: string, op: string, arg?: any): Promise<any> {
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
export async function dumpSite(env, ctx, url) {
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
				const data = (op: string, arg?: any) => objectData(env, site, version, key, className, op, arg);
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
export async function restoreSite(request, env, url) {
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
	const data = (op: string, arg?: any) => objectData(env, site, version, current.key, current.className, op, arg);
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
