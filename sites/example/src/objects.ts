// Durable Object classes this site provides. The router runs each named
// instance as a facet with its own SQLite database, reachable from routes via
// `objects.call(className, name, method, ...args)` (see #lib/server/objects).
// Arguments and return values must be plain data.
import { DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject {
	hit() {
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS hits (at TEXT NOT NULL)');
		sql.exec('INSERT INTO hits VALUES (?)', new Date().toISOString());
		const { n, first } = sql.exec('SELECT count(*) AS n, min(at) AS first FROM hits').one() as {
			n: number;
			first: string;
		};
		return { count: n, since: first };
	}
}

export interface Entry {
	id: number;
	name: string;
	message: string;
	at: string;
}

export class Guestbook extends DurableObject {
	#ready = false;

	#sql() {
		const sql = this.ctx.storage.sql;
		if (!this.#ready) {
			sql.exec(`CREATE TABLE IF NOT EXISTS entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				message TEXT NOT NULL,
				at TEXT NOT NULL
			)`);
			this.#ready = true;
		}
		return sql;
	}

	add(name: string, message: string) {
		this.#sql().exec(
			'INSERT INTO entries (name, message, at) VALUES (?, ?, ?)',
			name,
			message,
			new Date().toISOString()
		);
		return this.list();
	}

	list(limit = 20): { entries: Entry[]; total: number } {
		const sql = this.#sql();
		const entries = sql
			.exec('SELECT id, name, message, at FROM entries ORDER BY id DESC LIMIT ?', limit)
			.toArray() as unknown as Entry[];
		const { total } = sql.exec('SELECT count(*) AS total FROM entries').one() as { total: number };
		return { entries, total };
	}
}
