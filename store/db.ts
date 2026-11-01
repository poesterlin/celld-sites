// The store's database: Postgres, shared by the store and the moderation site.
//
// With DATABASE_URL the store talks to a Postgres server (the compose stack runs
// one, so the moderation site can read and decide on the same rows). Without it
// the store embeds Postgres (PGlite, WebAssembly) in <dataDir>/pg: one container,
// no database server, the same SQL. Tests use the embedded one.
//
// Schema changes are numbered migrations below; whoever starts first applies
// them, under an advisory lock, so the store and the moderation site can start
// in any order. An old SQLite catalog (store.db) is imported once, on first start.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Queries that run inside or outside a transaction. Parameters are $1, $2, … */
export interface Sql {
	query<T = any>(text: string, params?: unknown[]): Promise<T[]>;
	one<T = any>(text: string, params?: unknown[]): Promise<T | undefined>;
	/** Runs a statement and returns how many rows it changed. */
	run(text: string, params?: unknown[]): Promise<number>;
}

export interface Db extends Sql {
	kind: "postgres" | "embedded";
	/** Several statements, no parameters. */
	exec(text: string): Promise<void>;
	tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

/** Postgres' unique_violation: a concurrent insert won the race for a key. */
export const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === "23505";

type Runner = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null; affectedRows?: number }>;

function wrap(run: Runner): Sql {
	return {
		query: async (text, params) => (await run(text, params)).rows,
		one: async (text, params) => (await run(text, params)).rows[0],
		run: async (text, params) => {
			const result = await run(text, params);
			return Number(result.rowCount ?? result.affectedRows ?? 0);
		},
	};
}

export async function openDb({ url, dir }: { url?: string; dir?: string }): Promise<Db> {
	if (url) {
		const { default: pg } = await import("pg");
		const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
		// An idle client losing its connection must not crash the process; the
		// pool replaces it on the next query.
		pool.on("error", (err) => console.error("db: idle connection failed", err.message));
		const db: Db = {
			kind: "postgres",
			...wrap((text, params) => pool.query(text, params as any[])),
			exec: async (text) => {
				await pool.query(text);
			},
			async tx(fn) {
				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					const result = await fn(wrap((text, params) => client.query(text, params as any[])));
					await client.query("COMMIT");
					return result;
				} catch (err) {
					await client.query("ROLLBACK").catch(() => {});
					throw err;
				} finally {
					client.release();
				}
			},
			close: () => pool.end(),
		};
		return db;
	}
	const { PGlite } = await import("@electric-sql/pglite");
	let where = "memory://";
	if (dir) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		where = dir;
	}
	const lite = await PGlite.create(where);
	return {
		kind: "embedded",
		...wrap((text, params) => lite.query(text, params as any[])),
		exec: async (text) => {
			await lite.exec(text);
		},
		// PGlite has one connection; its transaction() holds it, so other queries
		// wait instead of interleaving.
		tx: (fn) => lite.transaction((t) => fn(wrap((text, params) => t.query(text, params as any[])))),
		close: () => lite.close(),
	};
}

// --- schema -------------------------------------------------------------------
// Append only: a released migration never changes, the next change is a new one.
const MIGRATIONS: string[] = [
	`
	CREATE TABLE publishers (
		id serial PRIMARY KEY,
		name text NOT NULL UNIQUE,
		password text NOT NULL,
		created_at timestamptz NOT NULL,
		-- When the publisher accepted the content policy (null: before there was one).
		policy_accepted_at timestamptz,
		-- Moderators trust this publisher: low-risk releases may skip the queue.
		trusted boolean NOT NULL DEFAULT false,
		-- Suspended publishers cannot sign in or publish, and their apps are hidden.
		suspended_at timestamptz,
		suspended_reason text
	);
	CREATE TABLE tokens (
		id text PRIMARY KEY,
		publisher_id integer NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
		hash text NOT NULL,
		-- "cli": a publisher token for the hamstr CLI; "session": a web sign-in.
		kind text NOT NULL DEFAULT 'cli',
		created_at timestamptz NOT NULL,
		last_used_at timestamptz,
		expires_at timestamptz
	);
	CREATE INDEX tokens_by_publisher ON tokens(publisher_id);
	CREATE TABLE apps (
		id serial PRIMARY KEY,
		slug text NOT NULL UNIQUE,
		publisher_id integer NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
		name text NOT NULL,
		summary text NOT NULL,
		description text NOT NULL DEFAULT '',
		homepage text,
		source text,
		license text NOT NULL,
		icon text NOT NULL DEFAULT '',
		category text,
		-- The manifest's tags in their order, for display; app_tags is the index.
		tags jsonb NOT NULL DEFAULT '[]',
		created_at timestamptz NOT NULL,
		updated_at timestamptz NOT NULL
	);
	CREATE INDEX apps_by_category ON apps(category);
	CREATE INDEX apps_by_publisher ON apps(publisher_id);
	CREATE TABLE app_tags (
		tag text NOT NULL,
		app_id integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
		PRIMARY KEY (tag, app_id)
	);
	-- status: uploading → pending → published, then yanked, removed or rejected.
	CREATE TABLE releases (
		id serial PRIMARY KEY,
		app_id integer NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
		version text NOT NULL,
		manifest jsonb NOT NULL,
		status text NOT NULL,
		bundle_sha text,
		bundle_size integer NOT NULL DEFAULT 0,
		source_sha text,
		source_size integer NOT NULL DEFAULT 0,
		created_at timestamptz NOT NULL,
		published_at timestamptz,
		downloads integer NOT NULL DEFAULT 0,
		-- The last moderation decision. review_note is shown to the publisher.
		reviewed_at timestamptz,
		reviewed_by text,
		review_note text,
		UNIQUE (app_id, version)
	);
	CREATE INDEX releases_by_app ON releases(app_id, status, published_at);
	CREATE INDEX releases_by_status ON releases(status, created_at);
	CREATE TABLE reports (
		id serial PRIMARY KEY,
		release_id integer NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
		reason text NOT NULL,
		created_at timestamptz NOT NULL,
		resolved boolean NOT NULL DEFAULT false,
		resolved_at timestamptz,
		resolved_by text
	);
	CREATE INDEX reports_open ON reports(resolved, created_at);
	CREATE TABLE demos (
		id text PRIMARY KEY,
		app_id integer NOT NULL,
		version text NOT NULL,
		host text NOT NULL,
		created_at timestamptz NOT NULL,
		expires_at timestamptz NOT NULL,
		status text NOT NULL,
		end_hash text
	);
	CREATE INDEX demos_running ON demos(status, expires_at);
	-- The audit log: publishers, the store and moderators all write here.
	CREATE TABLE events (
		id serial PRIMARY KEY,
		at timestamptz NOT NULL,
		actor text NOT NULL,
		action text NOT NULL,
		target text NOT NULL,
		note text
	);
	CREATE INDEX events_by_target ON events(target, at);
	-- The automatic checks of a release, written by the moderation site: one row
	-- per release, the latest run. Deleting the row queues the release again.
	CREATE TABLE moderation_checks (
		release_id integer PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
		status text NOT NULL,
		started_at timestamptz NOT NULL,
		finished_at timestamptz,
		-- allow | review | block
		verdict text,
		-- 0 (harmless) to 1 (harmful): the higher of the rules and the classifier.
		risk real,
		findings jsonb NOT NULL DEFAULT '[]',
		classifier jsonb,
		-- What the checks did on their own: published, rejected, or nothing.
		action text,
		error text
	);
	CREATE INDEX moderation_checks_by_verdict ON moderation_checks(verdict, risk);
	-- Switches the moderation site flips and the store reads: registration and
	-- publishing on or off.
	CREATE TABLE settings (
		key text PRIMARY KEY,
		value jsonb NOT NULL,
		updated_at timestamptz NOT NULL,
		updated_by text NOT NULL
	);
	`,
	// Namespaces: an app is <publisher>/<name> (apps.ref), so nobody can claim a
	// bare name like "notes" for everyone. Apps from before keep answering at
	// their old address (legacy); new apps never get one.
	`
	ALTER TABLE apps ADD COLUMN ref text;
	UPDATE apps a SET ref = p.name || '/' || a.slug FROM publishers p WHERE p.id = a.publisher_id;
	ALTER TABLE apps ALTER COLUMN ref SET NOT NULL;
	ALTER TABLE apps ADD CONSTRAINT apps_ref_key UNIQUE (ref);
	ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_slug_key;
	ALTER TABLE apps ADD CONSTRAINT apps_publisher_slug_key UNIQUE (publisher_id, slug);
	ALTER TABLE apps ADD COLUMN legacy boolean NOT NULL DEFAULT false;
	UPDATE apps SET legacy = true;
	-- A fresh password or token is when a stolen account publishes: such
	-- releases always go to a person.
	ALTER TABLE publishers ADD COLUMN password_changed_at timestamptz;
	`,
];

export async function migrate(db: Db): Promise<void> {
	await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
	await db.tx(async (sql) => {
		// Two processes starting together: the second waits here, then sees the
		// first one's migrations as applied.
		await sql.query("SELECT pg_advisory_xact_lock(4823901)");
		const done = new Set((await sql.query("SELECT version FROM schema_migrations")).map((r) => Number(r.version)));
		for (const [i, text] of MIGRATIONS.entries()) {
			const version = i + 1;
			if (done.has(version)) continue;
			for (const statement of splitStatements(text)) await sql.query(statement);
			await sql.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now())", [version]);
		}
	});
}

// Migrations hold several statements; a transaction runs them one by one (the
// extended protocol takes one statement per query). They contain no semicolons
// inside strings, so splitting on ";" at a line end is enough.
function splitStatements(text: string): string[] {
	return text
		.replace(/--[^\n]*/g, "")
		.split(/;\s*(?:\n|$)/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// --- one-time import of the SQLite catalog -------------------------------------
const SQLITE_TABLES: { name: string; columns: string[]; json?: string[]; bool?: string[] }[] = [
	{ name: "publishers", columns: ["id", "name", "password", "created_at"] },
	{ name: "tokens", columns: ["id", "publisher_id", "hash", "created_at", "last_used_at"] },
	{
		name: "apps",
		columns: ["id", "slug", "publisher_id", "name", "summary", "description", "homepage", "source", "license", "icon", "category", "tags", "created_at", "updated_at"],
		json: ["tags"],
	},
	{ name: "app_tags", columns: ["tag", "app_id"] },
	{
		name: "releases",
		columns: ["id", "app_id", "version", "manifest", "status", "bundle_sha", "bundle_size", "source_sha", "source_size", "created_at", "published_at", "downloads"],
		json: ["manifest"],
	},
	{ name: "reports", columns: ["id", "release_id", "reason", "created_at", "resolved"], bool: ["resolved"] },
	{ name: "events", columns: ["id", "at", "actor", "action", "target", "note"] },
];

/** Copies an old SQLite catalog into an empty database, keeping every id, then
 *  renames the file to store.db.imported. Returns false when there is nothing to
 *  import or the database already has publishers. */
export async function importSqlite(db: Db, dataDir: string): Promise<boolean> {
	const file = join(dataDir, "store.db");
	if (!existsSync(file)) return false;
	if (Number((await db.one("SELECT count(*)::int AS n FROM publishers"))?.n ?? 0) > 0) return false;
	const lite = new DatabaseSync(file);
	const counts: string[] = [];
	try {
		const has = (table: string, column: string) =>
			(lite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
		await db.tx(async (sql) => {
			for (const table of SQLITE_TABLES) {
				if (!lite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table.name)) continue;
				const columns = table.columns.filter((c) => has(table.name, c));
				const rows = lite.prepare(`SELECT ${columns.join(", ")} FROM ${table.name}`).all() as Record<string, unknown>[];
				// Every imported app predates namespaces: <publisher>/<slug>, legacy.
				const extra = table.name === "apps" ? ["ref", "legacy"] : [];
				const placeholders = [...columns, ...extra].map((c, i) => `$${i + 1}${table.json?.includes(c) ? "::jsonb" : ""}`).join(", ");
				for (const row of rows) {
					const values = columns.map((c) => {
						const value = row[c];
						if (table.json?.includes(c)) return typeof value === "string" && value ? value : "[]";
						if (table.bool?.includes(c)) return Boolean(value);
						return value ?? null;
					});
					if (extra.length) {
						const owner = await sql.one("SELECT name FROM publishers WHERE id = $1", [row.publisher_id]);
						values.push(`${owner.name}/${row.slug}`, true);
					}
					await sql.query(`INSERT INTO ${table.name} (${[...columns, ...extra].join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
				}
				counts.push(`${rows.length} ${table.name}`);
				if (columns.includes("id") && table.name !== "tokens") {
					await sql.query(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), COALESCE((SELECT max(id) FROM ${table.name}), 0) + 1, false)`);
				}
			}
		});
	} finally {
		lite.close();
	}
	renameSync(file, `${file}.imported`);
	console.log(`db: imported the SQLite catalog (${counts.join(", ")}); the old file is now store.db.imported`);
	return true;
}
