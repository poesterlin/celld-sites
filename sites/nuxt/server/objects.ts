// Durable Object classes for this site. celld-sites runs each (class, name)
// as its own SQLite-backed object; server routes reach them through
// server/utils/objects.ts. Arguments and return values must be plain data.
import { DurableObject } from 'cloudflare:workers';

const NOTES_TABLE = 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL)';

export interface Note {
	id: number;
	text: string;
	at: string;
}

export class Notes extends DurableObject {
	add(text: string): Note[] {
		const sql = this.ctx.storage.sql;
		sql.exec(NOTES_TABLE);
		sql.exec('INSERT INTO notes (text, at) VALUES (?, ?)', text, new Date().toISOString());
		return this.list();
	}

	list(): Note[] {
		const sql = this.ctx.storage.sql;
		sql.exec(NOTES_TABLE);
		return sql.exec('SELECT id, text, at FROM notes ORDER BY id DESC LIMIT 100').toArray() as unknown as Note[];
	}
}

export class Counter extends DurableObject {
	hit(): { count: number; since: string | null } {
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS hits (at TEXT NOT NULL)');
		sql.exec('INSERT INTO hits (at) VALUES (?)', new Date().toISOString());
		const row = sql.exec('SELECT count(*) AS n, min(at) AS first FROM hits').one() as { n: number; first: string };
		return { count: row.n, since: row.first };
	}
}
