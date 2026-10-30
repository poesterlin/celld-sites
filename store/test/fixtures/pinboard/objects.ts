import { DurableObject } from "cloudflare:workers";

/** One object ("board") per grain. A grain is its own celld site, so this name
 *  never collides with another board's. */
export class Board extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS pins (id INTEGER PRIMARY KEY, text TEXT NOT NULL, color TEXT NOT NULL, author TEXT NOT NULL, author_id TEXT, at TEXT NOT NULL)",
		);
	}
	list() {
		return this.ctx.storage.sql.exec("SELECT id, text, color, author, author_id AS authorId, at FROM pins ORDER BY id DESC LIMIT 200").toArray();
	}
	add(text, color, author, authorId) {
		this.ctx.storage.sql.exec("INSERT INTO pins (text, color, author, author_id, at) VALUES (?, ?, ?, ?, ?)", text, color, author, authorId, new Date().toISOString());
		return true;
	}
	/** Remove a pin; `authorId` limits it to the caller's own pins (null: any pin). */
	remove(id, authorId) {
		const sql = authorId === null ? "DELETE FROM pins WHERE id = ?" : "DELETE FROM pins WHERE id = ? AND author_id = ?";
		const cursor = authorId === null ? this.ctx.storage.sql.exec(sql, id) : this.ctx.storage.sql.exec(sql, id, authorId);
		return cursor.rowsWritten > 0;
	}
}
