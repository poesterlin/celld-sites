// Durable Object classes this site provides. The router runs each named
// instance with its own SQLite database, reachable from routes via
// `OBJECTS.call(className, name, method, ...args)` (see #lib/server/objects.ts).
// Arguments and return values must be plain data.
import { DurableObject } from 'cloudflare:workers';
import { checkNote, type Note } from './lib/note.ts';

// One board of notes: object name "main".
export class Notes extends DurableObject {
	#ready = false;

	#sql() {
		const sql = this.ctx.storage.sql;
		if (!this.#ready) {
			sql.exec(`CREATE TABLE IF NOT EXISTS notes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				text TEXT NOT NULL,
				at TEXT NOT NULL
			)`);
			this.#ready = true;
		}
		return sql;
	}

	add(input: string): { note: Note } | { error: string } {
		const checked = checkNote(input);
		if ('error' in checked) return checked;
		const sql = this.#sql();
		sql.exec('INSERT INTO notes (text, at) VALUES (?, ?)', checked.text, new Date().toISOString());
		const note = sql.exec('SELECT id, text, at FROM notes WHERE id = last_insert_rowid()').one() as unknown as Note;
		return { note };
	}

	list(limit = 50): { notes: Note[]; total: number } {
		const sql = this.#sql();
		const notes = sql
			.exec('SELECT id, text, at FROM notes ORDER BY id DESC LIMIT ?', limit)
			.toArray() as unknown as Note[];
		const { total } = sql.exec('SELECT count(*) AS total FROM notes').one() as { total: number };
		return { notes, total };
	}
}

// Page-view counter: object name "page-views".
export class Counter extends DurableObject {
	hit(): { count: number; since: string } {
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS hits (at TEXT NOT NULL)');
		sql.exec('INSERT INTO hits (at) VALUES (?)', new Date().toISOString());
		return sql.exec('SELECT count(*) AS count, min(at) AS since FROM hits').one() as {
			count: number;
			since: string;
		};
	}
}
