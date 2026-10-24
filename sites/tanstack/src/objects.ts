// Durable Object classes for this site, referenced by "objects" in celld.json.
// Each (class, name) pair is its own SQLite database, reached from server code
// as env.OBJECTS.call(className, name, method, ...args). Arguments and return
// values must be plain data.
import { DurableObject } from "cloudflare:workers";

export interface Note {
	id: number;
	text: string;
	at: string;
}

export class Notes extends DurableObject {
	#sql() {
		const sql = this.ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at TEXT NOT NULL)",
		);
		return sql;
	}

	add(text: string): Note[] {
		this.#sql().exec("INSERT INTO notes (text, at) VALUES (?, ?)", text, new Date().toISOString());
		return this.list();
	}

	list(limit = 50): Note[] {
		return this.#sql()
			.exec("SELECT id, text, at FROM notes ORDER BY id DESC LIMIT ?", limit)
			.toArray() as unknown as Note[];
	}
}

export class Counter extends DurableObject {
	hit(): number {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS hits (at TEXT NOT NULL)");
		sql.exec("INSERT INTO hits (at) VALUES (?)", new Date().toISOString());
		return sql.exec("SELECT count(*) AS n FROM hits").one().n as number;
	}
}
