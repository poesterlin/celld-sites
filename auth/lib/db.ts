// The auth service's SQLite database: people, how they sign in, groups, per-site
// rules, providers, invites, sessions and the audit log.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT,
	role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
	status TEXT NOT NULL CHECK (status IN ('active','disabled','pending')),
	created_at INTEGER NOT NULL,
	last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS providers (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('oidc','github','passkey')),
	name TEXT NOT NULL,
	config TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1,
	auto_approve INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
	provider_id TEXT NOT NULL,
	subject TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	email TEXT,
	label TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider_id, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
CREATE TABLE IF NOT EXISTS groups (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS site_rules (
	site TEXT PRIMARY KEY,
	access TEXT NOT NULL CHECK (access IN ('everyone','restricted','public')),
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_groups (
	site TEXT NOT NULL REFERENCES site_rules(site) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	PRIMARY KEY (site, group_id)
);
CREATE TABLE IF NOT EXISTS site_users (
	site TEXT NOT NULL REFERENCES site_rules(site) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	PRIMARY KEY (site, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	note TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL DEFAULT 'member',
	groups TEXT NOT NULL DEFAULT '[]',
	created_by TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	used_by TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	via TEXT,
	agent TEXT,
	ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS passkeys (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	public_key TEXT NOT NULL,
	alg INTEGER NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0,
	label TEXT NOT NULL DEFAULT 'Passkey',
	created_at INTEGER NOT NULL,
	last_used INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	actor TEXT,
	action TEXT NOT NULL,
	target TEXT,
	detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
`;

export function openDb(path: string): DatabaseSync {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	db.exec(SCHEMA);
	return db;
}
