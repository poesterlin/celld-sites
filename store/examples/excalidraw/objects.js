import { DurableObject } from "cloudflare:workers";

// Append-only: never edit or reorder an entry once it is deployed.
const MIGRATIONS = [
	(sql) => {
		sql.exec(
			"CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		);
		// No UNIQUE (element_index, board_id) like the original: elements without an
		// index would replace each other.
		sql.exec(
			"CREATE TABLE elements (id TEXT NOT NULL, board_id TEXT NOT NULL, data TEXT NOT NULL, element_index TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, board_id))",
		);
		sql.exec("CREATE INDEX elements_board ON elements (board_id)");
		sql.exec("CREATE TABLE files (id TEXT NOT NULL, board_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (id, board_id))");
		sql.exec("CREATE INDEX files_board ON files (board_id)");
		sql.exec("CREATE TABLE libraries (board_id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)");
	},
];

function migrate(storage) {
	const sql = storage.sql;
	sql.exec("CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)");
	let version = sql.exec("SELECT version FROM _schema").toArray()[0]?.version;
	if (version === undefined) {
		sql.exec("INSERT INTO _schema (version) VALUES (0)");
		version = 0;
	}
	for (; version < MIGRATIONS.length; version++) {
		storage.transactionSync(() => {
			MIGRATIONS[version](sql);
			sql.exec("UPDATE _schema SET version = ?", version + 1);
		});
	}
}

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** All boards of a grain live in one object ("main"): a grain is its own site,
 *  so nothing here is shared with another grain. Methods return plain data or
 *  `null` for "no such board"; the worker maps those to HTTP. */
export class Workspace extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
	}
	get sql() {
		return this.ctx.storage.sql;
	}
	board(id) {
		return this.sql.exec("SELECT * FROM boards WHERE id = ?", id).toArray()[0] ?? null;
	}
	touch(id) {
		this.sql.exec("UPDATE boards SET updated_at = ? WHERE id = ?", Date.now(), id);
	}

	listBoards(status) {
		const order = status === "ACTIVE" ? "created_at ASC" : "updated_at DESC";
		return this.sql.exec(`SELECT * FROM boards WHERE status = ? ORDER BY ${order}`, status).toArray();
	}
	createBoard() {
		const now = Date.now();
		const id = crypto.randomUUID();
		this.sql.exec("INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", id, stamp(), now, now);
		return this.board(id);
	}
	renameBoard(id, name) {
		const board = this.board(id);
		if (!board) return { error: 404, message: "Board not found" };
		if (board.status === "DELETED") return { error: 400, message: "Cannot update a board in trash" };
		if (typeof name === "string") this.sql.exec("UPDATE boards SET name = ? WHERE id = ?", name.slice(0, 200), id);
		this.touch(id);
		return this.board(id);
	}
	setStatus(id, status) {
		const board = this.board(id);
		if (!board) return { error: 404, message: "Board not found" };
		if (board.status === status) return { error: 400, message: status === "DELETED" ? "Board is already in trash" : "Board is not in trash" };
		this.sql.exec("UPDATE boards SET status = ? WHERE id = ?", status, id);
		this.touch(id);
		return this.board(id);
	}
	deleteBoard(id) {
		if (!this.board(id)) return { error: 404, message: "Board not found" };
		this.ctx.storage.transactionSync(() => {
			for (const table of ["elements", "files"]) this.sql.exec(`DELETE FROM ${table} WHERE board_id = ?`, id);
			this.sql.exec("DELETE FROM libraries WHERE board_id = ?", id);
			this.sql.exec("DELETE FROM boards WHERE id = ?", id);
		});
		return { ok: true };
	}

	scene(id) {
		if (!this.board(id)) return null;
		const parse = (row) => {
			try {
				return JSON.parse(row.data);
			} catch {
				return null;
			}
		};
		const elements = this.sql
			.exec("SELECT data FROM elements WHERE board_id = ? AND is_deleted = 0 ORDER BY element_index ASC", id)
			.toArray()
			.map(parse)
			.filter(Boolean);
		const files = {};
		for (const row of this.sql.exec("SELECT id, data FROM files WHERE board_id = ?", id).toArray()) {
			const file = parse(row);
			if (file) files[row.id] = { ...file, id: file.id || row.id };
		}
		return { elements, files };
	}
	putElements(id, elements) {
		const now = Date.now();
		for (const el of elements) {
			this.sql.exec(
				"INSERT INTO elements (id, board_id, data, element_index, type, created_at, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id, board_id) DO UPDATE SET data = excluded.data, element_index = excluded.element_index, type = excluded.type, updated_at = excluded.updated_at, is_deleted = excluded.is_deleted",
				String(el.id),
				id,
				JSON.stringify(el),
				el.index ?? "",
				String(el.type),
				now,
				now,
				el.isDeleted ? 1 : 0,
			);
		}
	}
	putFiles(id, files) {
		const now = Date.now();
		for (const [key, file] of Object.entries(files)) {
			const fileId = file.id || key;
			this.sql.exec(
				"INSERT INTO files (id, board_id, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id, board_id) DO NOTHING",
				fileId,
				id,
				JSON.stringify({ ...file, id: fileId }),
				now,
			);
		}
	}
	replaceScene(id, elements, files) {
		if (!this.board(id)) return null;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM elements WHERE board_id = ?", id);
			this.sql.exec("DELETE FROM files WHERE board_id = ?", id);
			this.putElements(id, elements);
			this.putFiles(id, files);
		});
		this.touch(id);
		return { ok: true };
	}
	applyDelta(id, upserted, deleted) {
		if (!this.board(id)) return null;
		this.ctx.storage.transactionSync(() => {
			this.putElements(id, upserted);
			for (const elementId of deleted) this.sql.exec("DELETE FROM elements WHERE board_id = ? AND id = ?", id, elementId);
		});
		this.touch(id);
		return { ok: true };
	}
	missingFiles(id, fileIds) {
		const have = new Set(this.sql.exec("SELECT id FROM files WHERE board_id = ?", id).toArray().map((row) => row.id));
		return fileIds.filter((fileId) => !have.has(fileId));
	}
	addFiles(id, files) {
		if (!this.board(id)) return null;
		this.ctx.storage.transactionSync(() => this.putFiles(id, files));
		return { ok: true };
	}

	library(id) {
		if (!this.board(id)) return null;
		const row = this.sql.exec("SELECT data FROM libraries WHERE board_id = ?", id).toArray()[0];
		try {
			const items = row ? JSON.parse(row.data) : [];
			return { libraryItems: Array.isArray(items) ? items : [] };
		} catch {
			return { libraryItems: [] };
		}
	}
	saveLibrary(id, items) {
		if (!this.board(id)) return null;
		this.sql.exec(
			"INSERT INTO libraries (board_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (board_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
			id,
			JSON.stringify(items),
			Date.now(),
		);
		this.touch(id);
		return { ok: true };
	}

	/** Everything, for Hamstr's "Download data". */
	exportAll() {
		return this.sql
			.exec("SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt FROM boards ORDER BY created_at")
			.toArray()
			.map((board) => ({ ...board, ...this.scene(board.id), library: this.library(board.id).libraryItems }));
	}
}
