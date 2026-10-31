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
			const options: { limit: number; startAfter?: string } = { limit: KV_PAGE };
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
export const DATA = `export const attach = ${attachData.toString()};\n`;
