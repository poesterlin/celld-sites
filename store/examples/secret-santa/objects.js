import { DurableObject } from "cloudflare:workers";

/** One object ("main") holds the names and, once drawn, the pairs. */
export class Draw extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS people (name TEXT PRIMARY KEY)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pairs (giver TEXT PRIMARY KEY, receiver TEXT NOT NULL)");
	}
	add(name) {
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO people (name) VALUES (?)", name);
		return this.list();
	}
	list() {
		return this.ctx.storage.sql.exec("SELECT name FROM people ORDER BY rowid").toArray().map((row) => row.name);
	}
	pairs() {
		return this.ctx.storage.sql.exec("SELECT giver, receiver FROM pairs ORDER BY rowid").toArray().map((row) => [row.giver, row.receiver]);
	}
	reset() {
		this.ctx.storage.sql.exec("DELETE FROM people");
		this.ctx.storage.sql.exec("DELETE FROM pairs");
		return true;
	}
	draw() {
		const names = this.list();
		if (names.length < 2) throw new Error("add at least two people first");
		const shift = 1 + Math.floor(Math.random() * (names.length - 1));
		const pairs = names.map((name, i) => [name, names[(i + shift) % names.length]]);
		this.ctx.storage.sql.exec("DELETE FROM pairs");
		for (const [giver, receiver] of pairs) {
			this.ctx.storage.sql.exec("INSERT INTO pairs (giver, receiver) VALUES (?, ?)", giver, receiver);
		}
		return pairs;
	}
}
