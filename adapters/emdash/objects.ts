// Durable Object classes for an EmDash site on celld-sites (see entry.ts).
// Each class has one instance per site: EmDashDB "emdash" (the CMS database),
// EmDashMedia "media" (uploaded files) and EmDashKV "session" (Astro sessions).
import { DurableObject } from "cloudflare:workers";
import { EmDashDB as EmDashDOSql } from "@emdash-cms/cloudflare/db/do-sql";

// celld keeps its replication state in `_litestream_*` tables inside each
// object's SQLite, and its authorizer refuses reading their schema. EmDash's
// introspector lists sqlite_master (skipping only Cloudflare's `_cf_*` tables)
// and runs pragma_table_info on each one, which then fails every migration
// with "not authorized". Hide celld's tables from schema listings.
const SCHEMA_QUERY = /\bsqlite_(master|schema)\b/i;
const withoutCelldTables = (sql, result) =>
	SCHEMA_QUERY.test(sql)
		? { ...result, rows: result.rows.filter((row) => !String(row.name ?? row.tbl_name ?? "").startsWith("_litestream_")) }
		: result;

export class EmDashDB extends EmDashDOSql {
	async query(sql, params, opts) {
		return withoutCelldTables(sql, await super.query(sql, params, opts));
	}
	async batchQuery(statements, opts) {
		return (await super.batchQuery(statements, opts)).map((result, i) => withoutCelldTables(statements[i].sql, result));
	}
}

// Files in 512 KiB rows, well below the SQLite row size limit of Durable Objects.
const CHUNK = 512 * 1024;

export class EmDashMedia extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, size INTEGER NOT NULL, etag TEXT NOT NULL, type TEXT NOT NULL, uploaded TEXT NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, n))");
	}
	#meta(row) {
		return row ? { key: row.key, size: row.size, etag: row.etag, contentType: row.type, uploaded: row.uploaded } : null;
	}
	head(key) {
		return this.#meta(this.ctx.storage.sql.exec("SELECT * FROM files WHERE key = ?", key).toArray()[0]);
	}
	async put(key, bytes, type) {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const etag = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
		this.ctx.storage.transactionSync(() => {
			const sql = this.ctx.storage.sql;
			sql.exec("DELETE FROM chunks WHERE key = ?", key);
			for (let at = 0, n = 0; at < bytes.byteLength; at += CHUNK, n++) sql.exec("INSERT INTO chunks VALUES (?, ?, ?)", key, n, bytes.slice(at, at + CHUNK));
			sql.exec("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)", key, bytes.byteLength, etag, type ?? "application/octet-stream", new Date().toISOString());
		});
		return this.head(key);
	}
	get(key) {
		const meta = this.head(key);
		if (!meta) return null;
		const bytes = new Uint8Array(meta.size);
		let at = 0;
		for (const { data } of this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE key = ? ORDER BY n", key)) {
			bytes.set(new Uint8Array(data), at);
			at += data.byteLength;
		}
		return { meta, bytes };
	}
	delete(keys) {
		this.ctx.storage.transactionSync(() => {
			for (const key of keys) {
				this.ctx.storage.sql.exec("DELETE FROM chunks WHERE key = ?", key);
				this.ctx.storage.sql.exec("DELETE FROM files WHERE key = ?", key);
			}
		});
	}
	list(prefix, limit, cursor) {
		limit = Math.max(1, Math.min(limit, 1000));
		// Keys after the cursor that start with the prefix: [prefix, prefix + U+FFFF).
		const rows = this.ctx.storage.sql
			.exec("SELECT * FROM files WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?", prefix, prefix + "￿", cursor ?? "", limit + 1)
			.toArray();
		const page = rows.slice(0, limit);
		const truncated = rows.length > limit;
		return { objects: page.map((row) => this.#meta(row)), truncated, cursor: truncated ? page.at(-1).key : undefined };
	}
}

export class EmDashKV extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)");
	}
	get(key) {
		const row = this.ctx.storage.sql.exec("SELECT value FROM kv WHERE key = ? AND (expires IS NULL OR expires > ?)", key, Date.now()).toArray()[0];
		return row ? row.value : null;
	}
	put(key, value, ttlSeconds) {
		const sql = this.ctx.storage.sql;
		// Expired sessions are only ever read as missing; drop them on the next write.
		sql.exec("DELETE FROM kv WHERE expires IS NOT NULL AND expires <= ?", Date.now());
		sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)", key, value, ttlSeconds ? Date.now() + ttlSeconds * 1000 : null);
	}
	delete(key) {
		this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key);
	}
	list(prefix) {
		return this.ctx.storage.sql
			.exec("SELECT key FROM kv WHERE key >= ? AND key < ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT 1000", prefix, prefix + "￿", Date.now())
			.toArray()
			.map((row) => row.key);
	}
}
