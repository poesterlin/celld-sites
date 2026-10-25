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
	spin() {
		for (;;) {}
	}
}
