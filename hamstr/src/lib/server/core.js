// Hamstr's core: configuration, the SQLite store, the access model, the Hamstr
// Store client, tickets and grain sessions. The SvelteKit routes and hooks are
// thin layers over this module; it has no SvelteKit imports, so the test
// harness (and any plain Node script) can drive it directly.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BundleError } from "../../../../packages/app-format/bundle.mjs";
import { ManifestError, validateManifest } from "../../../../packages/app-format/manifest.mjs";
import { CelldError, createCelld, downloadBundle } from "../../../lib/celld.mjs";
import { createOidc } from "../../../lib/oidc.mjs";
import { safePath } from "../../../lib/path.mjs";
import { siteOf } from "../../../lib/site.mjs";

export { CelldError, ManifestError, BundleError, safePath, siteOf };

const NAME = "Hamstr";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const GRAIN_SESSION_MS = 12 * 60 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const LOGIN_MS = 10 * 60 * 1000;
const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GRAINS_PER_USER = 500;
/** Largest backup Hamstr accepts for a restore or an import. */
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const BACKUP_EXTENSION = "hamstr-backup";

/** -1, 0 or 1 as semver a is older, the same or newer than b (pre-releases
 *  sort before their release). */
export function compareVersions(a, b) {
	const parse = (v) => {
		const [core, pre = ""] = String(v).split("+")[0].split(/-(.*)/s);
		return { nums: core.split(".").map((n) => Number(n) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const token = (bytes = 24) => randomBytes(bytes).toString("base64url");
const now = () => new Date().toISOString();
const strip = (value) => String(value ?? "").replace(/\/+$/, "");
const list = (value) =>
	String(value ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

function randomId(length = 12) {
	const bytes = randomBytes(length * 2);
	let out = "";
	for (const byte of bytes) {
		if (byte >= 252) continue; // 252 = 7 * 36: keep the alphabet unbiased
		out += ID_ALPHABET[byte % 36];
		if (out.length === length) return out;
	}
	return out + randomId(length - out.length);
}

export function parseCookies(header) {
	const out = {};
	for (const part of String(header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		const key = part.slice(0, i).trim();
		if (key && !(key in out)) out[key] = part.slice(i + 1).trim();
	}
	return out;
}

export function createCore(options = {}) {
	const env = process.env;
	const config = {
		port: Number(options.port ?? env.PORT ?? 3000),
		host: options.listenHost ?? env.HOST ?? "0.0.0.0",
		dataDir: resolve(options.dataDir ?? env.HAMSTR_DATA ?? "/data"),
		shellHost: String(options.shellHost ?? env.HAMSTR_HOST ?? "hamstr.localhost").toLowerCase(),
		grainDomain: String(options.grainDomain ?? env.HAMSTR_GRAIN_DOMAIN ?? "localhost").toLowerCase().replace(/^\.+/, ""),
		grainPrefix: options.grainPrefix ?? env.HAMSTR_GRAIN_PREFIX ?? "grain-",
		scheme: options.scheme ?? env.HAMSTR_SCHEME ?? "https",
		publicPort: String(options.publicPort ?? env.HAMSTR_PUBLIC_PORT ?? ""),
		store: strip(options.store ?? env.HAMSTR_STORE ?? "http://store:3000"),
		storePublic: strip(options.storePublic ?? env.HAMSTR_STORE_PUBLIC ?? env.HAMSTR_STORE ?? ""),
		celldApi: strip(options.celldApi ?? env.CELLD_ADMIN_API ?? "http://admin.internal:8080"),
		adminHost: options.adminHost ?? env.ADMIN_HOST ?? "admin.internal",
		adminToken: options.adminToken ?? env.ADMIN_TOKEN ?? "",
		proxyToken: options.proxyToken ?? env.PROXY_TOKEN ?? "",
		secret: options.secret ?? env.HAMSTR_SECRET ?? "",
		oidc: options.oidc ?? {
			issuer: env.OIDC_ISSUER ?? "",
			clientId: env.OIDC_CLIENT_ID ?? "",
			clientSecret: env.OIDC_CLIENT_SECRET ?? "",
		},
		admins: options.admins ?? list(env.HAMSTR_ADMINS),
		allowed: options.allowed ?? list(env.HAMSTR_ALLOWED_USERS),
		logging: options.logging !== false,
	};
	for (const [key, value] of [
		["ADMIN_TOKEN", config.adminToken],
		["PROXY_TOKEN", config.proxyToken],
		["HAMSTR_SECRET", config.secret],
		["OIDC_ISSUER", config.oidc.issuer],
		["OIDC_CLIENT_ID", config.oidc.clientId],
		["OIDC_CLIENT_SECRET", config.oidc.clientSecret],
	]) {
		if (!value) throw new Error(`${key} is required`);
	}
	if (!/^[a-z0-9-]+$/.test(config.grainPrefix)) throw new Error("HAMSTR_GRAIN_PREFIX must be lowercase letters, digits and dashes");

	const secure = config.scheme === "https";
	const portSuffix = config.publicPort ? `:${config.publicPort}` : "";
	const shellOrigin = `${config.scheme}://${config.shellHost}${portSuffix}`;
	const grainHost = (id) => `${config.grainPrefix}${id}.${config.grainDomain}`;
	const grainOrigin = (id) => `${config.scheme}://${grainHost(id)}${portSuffix}`;
	const grainPattern = new RegExp(`^${config.grainPrefix}([a-z0-9]{12})\\.${config.grainDomain.replace(/[.]/g, "\\.")}$`);
	const SHELL_COOKIE = secure ? "__Host-hamstr" : "hamstr";
	const GRAIN_COOKIE = secure ? "__Host-hamstr_grain" : "hamstr_grain";
	const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
	// The grain cookie is set and sent inside the shell's iframe. When the shell
	// and the grains share a site (hamstr.example.com, grain-x.example.com) a Lax
	// cookie works. On another site (a separate grain domain, or *.localhost,
	// where every name is its own site) it is a third-party cookie, so it is
	// partitioned to the shell instead (CHIPS: Chrome, Edge, Firefox).
	const sameSite = siteOf(config.shellHost) === siteOf(`${config.grainPrefix}x.${config.grainDomain}`);
	const grainCookieMode = options.grainCookieMode ?? env.HAMSTR_GRAIN_COOKIE ?? (sameSite ? "lax" : "partitioned");
	const grainCookieAttrs = grainCookieMode === "lax" ? cookieAttrs : "Path=/; HttpOnly; SameSite=None; Secure; Partitioned";

	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const tmpDir = join(config.dataDir, "tmp");
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

	const oidc = createOidc({ ...config.oidc, redirectUri: `${shellOrigin}/auth/callback` });
	const celld = createCelld({ api: config.celldApi, adminHost: config.adminHost, adminToken: config.adminToken, tmpDir });
	const sitesApi = new URL(options.sitesApi ?? env.CELLD_SITES_API ?? config.celldApi);

	// --- database ----------------------------------------------------------------
	const db = new DatabaseSync(join(config.dataDir, "hamstr.db"));
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, login TEXT,
			created_at TEXT NOT NULL, seen_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS sessions (
			hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS logins (
			state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, next TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS apps (
			slug TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, summary TEXT NOT NULL, version TEXT NOT NULL,
			code_version TEXT NOT NULL, bundle_sha TEXT NOT NULL, manifest TEXT NOT NULL, installed_by TEXT,
			installed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS grains (
			id TEXT PRIMARY KEY, slug TEXT NOT NULL REFERENCES apps(slug), title TEXT NOT NULL,
			owner_id TEXT NOT NULL REFERENCES users(id), code_version TEXT NOT NULL,
			created_at TEXT NOT NULL, opened_at TEXT, trashed_at TEXT);
		CREATE INDEX IF NOT EXISTS grains_owner ON grains(owner_id);
		CREATE TABLE IF NOT EXISTS tickets (
			hash TEXT PRIMARY KEY, grain_id TEXT NOT NULL, user_id TEXT, parent TEXT,
			path TEXT NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS grain_sessions (
			hash TEXT PRIMARY KEY, grain_id TEXT NOT NULL REFERENCES grains(id) ON DELETE CASCADE,
			user_id TEXT, parent TEXT, public_id TEXT NOT NULL,
			created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
	`);
	// Share links were removed: drop their tables and columns from databases that
	// still have them (new databases never create them). Tickets are short-lived,
	// so dropping share_id from them and from grain_sessions loses nothing.
	if (db.prepare("PRAGMA user_version").get().user_version < 1) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec("DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS shares;");
			for (const table of ["tickets", "grain_sessions"]) {
				if (db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'share_id'`).get()) db.exec(`ALTER TABLE ${table} DROP COLUMN share_id`);
			}
			db.exec("PRAGMA user_version = 1");
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}
	const tx = (fn) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	};
	const q = {
		user: db.prepare("SELECT * FROM users WHERE id = ?"),
		userBySub: db.prepare("SELECT * FROM users WHERE sub = ?"),
		session: db.prepare("SELECT s.*, u.name, u.email, u.login, u.sub FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?"),
		app: db.prepare("SELECT * FROM apps WHERE slug = ?"),
		grain: db.prepare("SELECT * FROM grains WHERE id = ?"),
	};

	// --- identity --------------------------------------------------------------------
	const matches = (entries, user) => {
		const names = [user.email, user.login, user.sub].filter(Boolean).map((s) => String(s).toLowerCase());
		// "*" matches everyone the IdP signs in (HAMSTR_ADMINS=* makes every user an admin).
		return entries.some((entry) => entry === "*" || names.includes(entry));
	};
	const isAdmin = (user) => matches(config.admins, user);
	/** What apps see as the user id: stable, but not the IdP's subject or email. */
	const publicUserId = (userId) => createHmac("sha256", config.secret).update(`user:${userId}`).digest("hex").slice(0, 32);

	function sessionFor(request) {
		const value = parseCookies(request.headers.get("cookie"))[SHELL_COOKIE];
		if (!value || value.length > 200) return null;
		const hash = sha256(value);
		const row = q.session.get(hash, Date.now());
		return row ? { hash, user: { id: row.user_id, name: row.name, email: row.email, login: row.login, sub: row.sub } } : null;
	}

	// --- apps and the access model ---------------------------------------------------
	const manifestOf = (app) => (app ? JSON.parse(app.manifest) : null);
	/** A grain belongs to its owner alone: they hold every permission the app
	 *  declares, and nobody else gets in. */
	function accessFor(grain, { userId = null } = {}) {
		if (!grain || grain.trashed_at || !userId || grain.owner_id !== userId) return null;
		const manifest = manifestOf(q.app.get(grain.slug));
		return { role: "owner", permissions: (manifest?.permissions ?? []).map((p) => p.id), owner: true };
	}

	function appJson(app, extra = {}) {
		const m = manifestOf(app);
		return {
			slug: app.slug,
			name: app.name,
			icon: app.icon,
			summary: app.summary,
			description: m.description ?? "",
			license: m.license ?? "",
			homepage: m.homepage ?? null,
			source: m.source ?? null,
			version: app.version,
			canExport: Boolean(m.export),
			egress: m.egress ?? [],
			instances: m.instances ?? "many",
			installedAt: app.installed_at,
			updatedAt: app.updated_at,
			...extra,
		};
	}
	function grainJson(grain, access, extra = {}) {
		const app = q.app.get(grain.slug);
		const owner = q.user.get(grain.owner_id);
		return {
			id: grain.id,
			title: grain.title,
			app: app ? { slug: app.slug, name: app.name, icon: app.icon } : { slug: grain.slug, name: grain.slug, icon: "" },
			owner: { name: owner?.name ?? "someone" },
			createdAt: grain.created_at,
			openedAt: grain.opened_at,
			trashedAt: grain.trashed_at,
			origin: grainOrigin(grain.id),
			...(access && { role: access.role, permissions: access.permissions, isOwner: access.owner }),
			...extra,
		};
	}

	// --- store ---------------------------------------------------------------------
	async function storeJson(path) {
		let res;
		try {
			res = await fetch(`${config.store}${path}`, { signal: AbortSignal.timeout(30_000) });
		} catch {
			throw new HttpError(502, "the app store is unreachable");
		}
		const text = await res.text();
		let body = {};
		try {
			body = JSON.parse(text);
		} catch {}
		if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, body.error || `the store answered ${res.status}`);
		return body;
	}

	/** Install or update an app; updates move every grain of it to the new code. */
	const installing = new Map();
	async function install(slug, { version, allowEgress, user }) {
		if (installing.has(slug)) throw new HttpError(409, `${slug} is already being installed`);
		const job = (async () => {
			const detail = await storeJson(`/api/v1/apps/${encodeURIComponent(slug)}`);
			const releases = (detail.releases ?? []).filter((r) => r.status === "published");
			const release = version ? releases.find((r) => r.version === version) : releases[0];
			if (!release) throw new HttpError(404, version ? `${slug}@${version} is not published` : `${slug} has no published release`);
			let manifest;
			try {
				manifest = validateManifest(release.manifest);
			} catch (err) {
				throw new HttpError(422, `the store's manifest is invalid: ${err.message}`);
			}
			if (manifest.slug !== slug) throw new HttpError(422, "the release manifest is for another app");
			const existing = q.app.get(slug);
			const oldEgress = existing ? (manifestOf(existing).egress ?? []) : [];
			const newEgress = manifest.egress ?? [];
			const needsConsent = newEgress.some((h) => !oldEgress.includes(h));
			if (needsConsent && !allowEgress) {
				throw new HttpError(403, `${manifest.name} wants network access to ${newEgress.join(", ")}; review and allow it first`);
			}
			const { file, sha } = await downloadBundle(config.store, slug, release.version, release.bundleSha256, tmpDir);
			let uploaded;
			try {
				uploaded = await celld.upload(file, { egress: newEgress, probeHost: `${config.grainPrefix}probe-${randomId(8)}.${config.grainDomain}` });
			} finally {
				rmSync(file, { force: true });
			}
			const stamp = now();
			if (existing) {
				db.prepare(
					"UPDATE apps SET name = ?, icon = ?, summary = ?, version = ?, code_version = ?, bundle_sha = ?, manifest = ?, updated_at = ? WHERE slug = ?",
				).run(manifest.name, manifest.icon, manifest.summary, manifest.version, uploaded.version, sha, JSON.stringify(manifest), stamp, slug);
			} else {
				db.prepare(
					"INSERT INTO apps (slug, name, icon, summary, version, code_version, bundle_sha, manifest, installed_by, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(slug, manifest.name, manifest.icon, manifest.summary, manifest.version, uploaded.version, sha, JSON.stringify(manifest), user.id, stamp, stamp);
			}
			// Move existing grains. Their Durable Objects keep their data; migrations run on first use.
			const failed = [];
			let moved = 0;
			for (const grain of db.prepare("SELECT * FROM grains WHERE slug = ?").all(slug)) {
				if (grain.code_version === uploaded.version) continue;
				try {
					await celld.deployGrain(grainHost(grain.id), uploaded.version, newEgress);
					db.prepare("UPDATE grains SET code_version = ? WHERE id = ?").run(uploaded.version, grain.id);
					moved++;
				} catch (err) {
					failed.push({ id: grain.id, error: err.message });
				}
			}
			return { app: appJson(q.app.get(slug)), updatedGrains: moved, failedGrains: failed };
		})();
		installing.set(slug, job);
		try {
			return await job;
		} finally {
			installing.delete(slug);
		}
	}

	/** A new grain of an installed app, as its own celld site. */
	async function createGrain(user, app, title = "") {
		if (db.prepare("SELECT COUNT(*) AS n FROM grains WHERE owner_id = ?").get(user.id).n >= MAX_GRAINS_PER_USER) {
			throw new HttpError(403, `you can have at most ${MAX_GRAINS_PER_USER} grains`);
		}
		const id = randomId(12);
		try {
			await celld.deployGrain(grainHost(id), app.code_version, manifestOf(app).egress ?? []);
		} catch (err) {
			await celld.deleteSite(grainHost(id)).catch(() => {});
			throw err;
		}
		const name = String(title).trim().slice(0, 80) || (manifestOf(app).instances === "single" ? app.name : `Untitled ${app.name}`);
		db.prepare("INSERT INTO grains (id, slug, title, owner_id, code_version, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, app.slug, name, user.id, app.code_version, now());
		return q.grain.get(id);
	}

	/** Open an app from the home screen. A single-instance app has one grain per
	 *  person: the newest one that is not in the trash, made on first open. */
	const opening = new Map();
	async function openApp(user, app) {
		const find = () =>
			db.prepare("SELECT * FROM grains WHERE owner_id = ? AND slug = ? AND trashed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(user.id, app.slug);
		const existing = find();
		if (existing) return { grain: existing, created: false };
		// Two taps (or two tabs) at once must not make two grains.
		const key = `${user.id}/${app.slug}`;
		if (!opening.has(key)) opening.set(key, createGrain(user, app).finally(() => opening.delete(key)));
		const grain = await opening.get(key);
		return { grain, created: true };
	}

	// --- backups ---------------------------------------------------------------------
	// A backup file is one header line (what it is a backup of) followed by celld's
	// dump of the grain's objects: every table, row and stored key, so it works for
	// every app, whether or not the app has an export of its own.
	const tempFiles = new Set(); // in use: housekeeping leaves them alone
	const restoring = new Set(); // grain ids: the proxy holds their traffic meanwhile
	const isRestoring = (id) => restoring.has(id);

	function tempFile(kind) {
		const file = join(tmpDir, `${kind}-${randomId(12)}.${BACKUP_EXTENSION}`);
		tempFiles.add(file);
		return file;
	}
	function releaseTemp(file) {
		tempFiles.delete(file);
		rmSync(file, { force: true });
	}

	/** Back a grain up into a temp file; the caller sends it and releases it. */
	async function backupGrain(grain) {
		const app = q.app.get(grain.slug);
		const file = tempFile("backup");
		try {
			const header = {
				type: "hamstr-backup",
				format: 1,
				app: grain.slug,
				appName: app?.name ?? grain.slug,
				appVersion: app?.version ?? null,
				title: grain.title,
				at: now(),
			};
			writeFileSync(file, `${JSON.stringify(header)}\n`, { mode: 0o600 });
			const totals = await celld.dumpTo(grainHost(grain.id), file);
			return { file, header, totals };
		} catch (err) {
			releaseTemp(file);
			throw err;
		}
	}

	/** The header of a backup file and where celld's part starts. */
	function readBackupHeader(file) {
		const buf = Buffer.alloc(16 * 1024);
		const fd = openSync(file, "r");
		let n;
		try {
			n = readSync(fd, buf, 0, buf.length, 0);
		} finally {
			closeSync(fd);
		}
		const nl = buf.subarray(0, n).indexOf(10);
		let header = null;
		try {
			header = nl > 0 ? JSON.parse(buf.subarray(0, nl).toString("utf8")) : null;
		} catch {}
		if (header?.type !== "hamstr-backup" || header.format !== 1 || typeof header.app !== "string") {
			throw new HttpError(422, `that is not a ${NAME} backup (a .${BACKUP_EXTENSION} file)`);
		}
		return { header, offset: nl + 1 };
	}

	/** Why a backup can't go into an item of `app`, or nothing. */
	function checkBackupFor(header, app) {
		if (header.app !== app.slug) throw new HttpError(422, `that is a backup of ${String(header.appName ?? header.app).slice(0, 80)}, not ${app.name}`);
		if (header.appVersion && compareVersions(header.appVersion, app.version) > 0) {
			throw new HttpError(409, `that backup was made with ${app.name} ${header.appVersion}, newer than this Hamstr's ${app.version}; update the app first`);
		}
	}

	/** Replace a grain's data with a backup file. A copy of its current data is
	 *  taken first and put back if the restore fails half-way. */
	async function restoreGrain(grain, file) {
		const app = q.app.get(grain.slug);
		if (!app) throw new HttpError(409, "the app of this item is not installed");
		const { header, offset } = readBackupHeader(file);
		checkBackupFor(header, app);
		if (restoring.has(grain.id)) throw new HttpError(409, "this item is already being restored");
		const host = grainHost(grain.id);
		restoring.add(grain.id);
		const safety = tempFile("before-restore");
		try {
			try {
				await celld.dumpTo(host, safety);
			} catch (err) {
				throw new HttpError(502, `could not take a safety copy of the current data first, so nothing was changed (${err.message})`);
			}
			const r = await celld.restoreFrom(host, file, offset);
			if (r.status === 200) return { header, ...r.json };
			const why = String(r.json?.error ?? `status ${r.status}`).replace(/^restore failed: /, "");
			if (r.json?.changed) {
				const back = await celld.restoreFrom(host, safety).catch((err) => ({ status: 0, json: { error: err.message } }));
				if (back.status !== 200) {
					throw new HttpError(502, `the restore failed (${why}), and putting the previous data back failed too (${back.json?.error}); the item may be incomplete`);
				}
				throw new HttpError(422, `the restore failed (${why}); the item was put back as it was`);
			}
			throw new HttpError(r.status === 429 ? 429 : 422, `the restore failed (${why}); nothing was changed`);
		} finally {
			releaseTemp(safety);
			restoring.delete(grain.id);
		}
	}

	/** A new grain of `app` made from a backup file. */
	async function importBackup(user, app, file) {
		const { header } = readBackupHeader(file);
		checkBackupFor(header, app);
		const grain = await createGrain(user, app, typeof header.title === "string" ? header.title : "");
		try {
			const result = await restoreGrain(grain, file);
			return { grain: q.grain.get(grain.id), ...result };
		} catch (err) {
			await purgeGrain(grain).catch(() => {});
			throw err;
		}
	}

	async function purgeGrain(grain) {
		await celld.deleteSite(grainHost(grain.id));
		db.prepare("DELETE FROM grains WHERE id = ?").run(grain.id);
	}

	/** What uninstalling an app would delete, as seen by `user`. */
	function usage(slug, user) {
		const row = db
			.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(owner_id = ?), 0) AS mine, COUNT(DISTINCT owner_id) AS owners FROM grains WHERE slug = ?")
			.get(user.id, slug);
		return { items: row.total, mine: row.mine, others: row.total - row.mine, people: row.owners };
	}

	/** Remove an app for everyone. Its grains (with their data, trash included)
	 *  go too, but only when `deleteItems` says so; a failed delete keeps the app. */
	async function uninstall(slug, { deleteItems = false } = {}) {
		const app = q.app.get(slug);
		if (!app) throw new HttpError(404, "that app is not installed");
		if (installing.has(slug)) throw new HttpError(409, `${app.name} is being installed or updated right now`);
		const grains = db.prepare("SELECT * FROM grains WHERE slug = ?").all(slug);
		if (grains.length && !deleteItems) {
			throw new HttpError(409, `${app.name} still has ${grains.length} item${grains.length === 1 ? "" : "s"} (including the trash)`);
		}
		const failed = [];
		for (const grain of grains) {
			try {
				await purgeGrain(grain);
			} catch (err) {
				failed.push(grain.id);
				console.error(`hamstr: deleting grain ${grain.id} failed`, err.message);
			}
		}
		if (failed.length) throw new HttpError(502, `${failed.length} item${failed.length === 1 ? "" : "s"} could not be deleted; ${app.name} stays installed, try again`);
		db.prepare("DELETE FROM apps WHERE slug = ?").run(slug);
		return { deleted: grains.length };
	}

	// --- tickets and grain sessions ----------------------------------------------------
	function issueTicket(grain, { userId, parent = null, path = "/" }) {
		const value = token();
		db.prepare("INSERT INTO tickets (hash, grain_id, user_id, parent, path, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
			sha256(value),
			grain.id,
			userId,
			parent,
			safePath(path),
			Date.now() + TICKET_MS,
		);
		db.prepare("UPDATE grains SET opened_at = ? WHERE id = ?").run(now(), grain.id);
		return `${grainOrigin(grain.id)}/.hamstr/enter?ticket=${encodeURIComponent(value)}`;
	}

	/** The visitor behind a grain request, or null. Re-checked on every request,
	 *  so revoking a link, trashing a grain or signing out takes effect at once. */
	function grainVisitor(request, grain) {
		const value = parseCookies(request.headers.get("cookie"))[GRAIN_COOKIE];
		if (!value || value.length > 200) return null;
		const gs = db.prepare("SELECT * FROM grain_sessions WHERE hash = ? AND expires_at > ?").get(sha256(value), Date.now());
		if (!gs || gs.grain_id !== grain.id) return null;
		if (gs.parent && !db.prepare("SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?").get(gs.parent, Date.now())) return null;
		const access = accessFor(grain, { userId: gs.user_id });
		if (!access) return null;
		return { gs, access, user: gs.user_id ? q.user.get(gs.user_id) : null };
	}

	// --- housekeeping ------------------------------------------------------------------
	async function housekeeping() {
		const t = Date.now();
		db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
		db.prepare("DELETE FROM grain_sessions WHERE expires_at < ?").run(t);
		db.prepare("DELETE FROM tickets WHERE expires_at < ?").run(t);
		db.prepare("DELETE FROM logins WHERE created_at < ?").run(t - LOGIN_MS);
		const cutoff = new Date(t - TRASH_MS).toISOString();
		for (const grain of db.prepare("SELECT * FROM grains WHERE trashed_at IS NOT NULL AND trashed_at < ?").all(cutoff)) {
			try {
				await purgeGrain(grain);
			} catch (err) {
				console.error(`hamstr: purging grain ${grain.id} failed`, err.message);
			}
		}
		for (const name of readdirSync(tmpDir)) {
			if (!installing.size && !tempFiles.has(join(tmpDir, name))) rmSync(join(tmpDir, name), { recursive: true, force: true });
		}
	}
	const timer = setInterval(() => housekeeping().catch((err) => console.error("hamstr: housekeeping failed", err)), 10 * 60 * 1000);
	timer.unref();

	return {
		NAME,
		config,
		db,
		celld,
		oidc,
		tmpDir,
		sitesApi,
		shellOrigin,
		grainHost,
		grainOrigin,
		grainPattern,
		grainSources: `${config.scheme}://*.${config.grainDomain}${portSuffix}`,
		SHELL_COOKIE,
		GRAIN_COOKIE,
		cookieAttrs,
		grainCookieAttrs,
		SESSION_MS,
		GRAIN_SESSION_MS,
		LOGIN_MS,
		TICKET_MS,
		TRASH_MS,
		MAX_GRAINS_PER_USER,
		MAX_BACKUP_BYTES,
		BACKUP_EXTENSION,
		tempFile,
		releaseTemp,
		backupGrain,
		restoreGrain,
		importBackup,
		isRestoring,
		sha256,
		token,
		now,
		randomId,
		tx,
		q,
		matches,
		isAdmin,
		publicUserId,
		sessionFor,
		manifestOf,
		accessFor,
		appJson,
		grainJson,
		storeJson,
		install,
		createGrain,
		openApp,
		purgeGrain,
		usage,
		uninstall,
		issueTicket,
		grainVisitor,
		housekeeping,
		close() {
			clearInterval(timer);
			db.close();
		},
	};
}
