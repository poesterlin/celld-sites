import { DurableObject } from "cloudflare:workers";

export class Kv extends DurableObject {
	#sql() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
		return this.ctx.storage.sql;
	}
	put(k, v) {
		this.#sql().exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
		return true;
	}
	get(k) {
		const row = this.#sql().exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
		return row ? JSON.parse(row.v) : null;
	}
	echo(...args) {
		return args;
	}
	boom() {
		throw new Error("boom from the object");
	}
	fn() {
		return () => 1;
	}
	async hang() {
		await new Promise((r) => setTimeout(r, 10_000));
		return "too late";
	}
	spin() {
		for (;;) {}
	}
}

// Backups: a bit of everything a dump has to carry. The trigger and the
// generated column check that a restore neither replays triggers nor writes
// computed values.
export class Store extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		const s = ctx.storage.sql;
		s.exec("CREATE TABLE IF NOT EXISTS parent (id INTEGER PRIMARY KEY, label TEXT, data BLOB, n REAL)");
		s.exec("CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parent(id), note TEXT)");
		s.exec("CREATE INDEX IF NOT EXISTS child_parent ON child(parent)");
		s.exec("CREATE TABLE IF NOT EXISTS tags (tag TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID");
		s.exec("CREATE TABLE IF NOT EXISTS log (msg TEXT, len INTEGER GENERATED ALWAYS AS (length(msg)) VIRTUAL)");
		s.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body)");
		s.exec("CREATE TRIGGER IF NOT EXISTS log_child AFTER INSERT ON child BEGIN INSERT INTO log (msg) VALUES ('child ' || new.id); END");
	}
	async fill(n = 3, bigRows = 0) {
		const s = this.ctx.storage.sql;
		for (let i = 1; i <= n; i++) {
			s.exec("INSERT INTO parent (label, data, n) VALUES (?, ?, ?)", `p${i}`, new Uint8Array([i, 0, 255]), i / 3);
			s.exec("INSERT INTO child (parent, note) VALUES (?, ?)", i, `c${i} "quoted" ü`);
			s.exec("INSERT INTO tags (tag, n) VALUES (?, ?)", `t${i}`, i);
			s.exec("INSERT INTO search (body) VALUES (?)", `note number ${i} about hamsters`);
		}
		s.exec("DELETE FROM log WHERE msg = 'child 2'"); // a gap in log's rowids
		const filler = "x".repeat(1000);
		for (let i = 0; i < bigRows; i++) s.exec("INSERT INTO log (msg) VALUES (?)", `${i} ${filler}`);
		await this.ctx.storage.put({
			date: new Date(Date.UTC(2026, 9, 30)),
			bytes: new Uint8Array([1, 2, 3]),
			map: new Map([[1, "one"]]),
			set: new Set(["a"]),
			big: 12345678901234567890n,
			nan: NaN,
			dollar: { $: "not a tag", list: [1, null, undefined] },
		});
		return true;
	}
	mutate() {
		const s = this.ctx.storage.sql;
		s.exec("DELETE FROM child");
		s.exec("INSERT INTO tags (tag, n) VALUES ('new', 0)");
		return this.ctx.storage.delete("date");
	}
	async snapshot() {
		const s = this.ctx.storage.sql;
		const rows = (q) => s.exec(q).toArray();
		const hex = (b) => (b ? [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") : null);
		const show = (v) =>
			v instanceof Date ? `date:${v.toISOString()}` : v instanceof Uint8Array ? `bytes:${hex(v)}` : v instanceof Map ? `map:${JSON.stringify([...v])}` : v instanceof Set ? `set:${JSON.stringify([...v])}` : typeof v === "bigint" ? `big:${v}` : typeof v === "number" && Number.isNaN(v) ? "NaN" : v && typeof v === "object" ? `obj:${JSON.stringify(v, (k, x) => (x === undefined ? "<undef>" : x))}` : v;
		return {
			parent: rows("SELECT id, label, data, n FROM parent ORDER BY id").map((r) => ({ ...r, data: hex(r.data) })),
			child: rows("SELECT * FROM child ORDER BY id"),
			tags: rows("SELECT * FROM tags ORDER BY tag"),
			log: rows("SELECT rowid, msg, len FROM log ORDER BY rowid").map((r) => [r.rowid, r.msg.slice(0, 20), r.len]),
			search: rows("SELECT rowid FROM search WHERE search MATCH 'hamsters' ORDER BY rowid").map((r) => r.rowid),
			schema: rows("SELECT type, name FROM sqlite_master WHERE name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' ORDER BY type, name").map((r) => `${r.type} ${r.name}`),
			kv: [...(await this.ctx.storage.list())].map(([k, v]) => [k, show(v)]),
		};
	}
}
