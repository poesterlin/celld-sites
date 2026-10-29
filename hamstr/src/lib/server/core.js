// Hamstr's core: configuration, the SQLite store, the access model, the Cubby
// store client, tickets and grain sessions. The SvelteKit routes and hooks are
// thin layers over this module; it has no SvelteKit imports, so the test
// harness (and any plain Node script) can drive it directly.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BundleError } from "../../../../cubby/lib/bundle.mjs";
import { ManifestError, validateManifest } from "../../../../cubby/lib/manifest.mjs";
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
const MAX_SHARES_PER_GRAIN = 50;

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
		store: strip(options.store ?? env.HAMSTR_STORE ?? "http://cubby:3000"),
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
		CREATE TABLE IF NOT EXISTS shares (
			id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, grain_id TEXT NOT NULL REFERENCES grains(id) ON DELETE CASCADE,
			role TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
			created_at TEXT NOT NULL, revoked_at TEXT);
		CREATE TABLE IF NOT EXISTS members (
			share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			joined_at TEXT NOT NULL, PRIMARY KEY (share_id, user_id));
		CREATE TABLE IF NOT EXISTS tickets (
			hash TEXT PRIMARY KEY, grain_id TEXT NOT NULL, user_id TEXT, share_id TEXT, parent TEXT,
			path TEXT NOT NULL, expires_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS grain_sessions (
			hash TEXT PRIMARY KEY, grain_id TEXT NOT NULL REFERENCES grains(id) ON DELETE CASCADE,
			user_id TEXT, share_id TEXT, parent TEXT, public_id TEXT NOT NULL,
			created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
	`);
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
		share: db.prepare("SELECT * FROM shares WHERE id = ?"),
		shareByHash: db.prepare("SELECT * FROM shares WHERE hash = ?"),
		memberRoles: db.prepare(
			"SELECT s.role FROM members m JOIN shares s ON s.id = m.share_id WHERE m.user_id = ? AND s.grain_id = ? AND s.revoked_at IS NULL",
		),
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
	/** Turn the roles a visitor holds into one role name and a permission set. */
	function combine(manifest, roleIds) {
		const declared = manifest?.roles ?? [];
		if (!declared.length) return { role: "member", permissions: (manifest?.permissions ?? []).map((p) => p.id) };
		const byId = new Map(declared.map((r) => [r.id, r]));
		// A role the app no longer declares degrades to its least privileged role.
		const weakest = [...declared].sort((a, b) => a.permissions.length - b.permissions.length)[0];
		const held = [...roleIds].map((id) => byId.get(id) ?? weakest);
		const strongest = [...held].sort((a, b) => b.permissions.length - a.permissions.length)[0];
		return { role: strongest.id, permissions: [...new Set(held.flatMap((r) => r.permissions))] };
	}
	function accessFor(grain, { userId = null, shareId = null } = {}) {
		if (!grain || grain.trashed_at) return null;
		const manifest = manifestOf(q.app.get(grain.slug));
		if (userId && grain.owner_id === userId) return { role: "owner", permissions: (manifest?.permissions ?? []).map((p) => p.id), owner: true };
		const roles = new Set();
		if (shareId) {
			const share = q.share.get(shareId);
			if (share && !share.revoked_at && share.grain_id === grain.id) roles.add(share.role);
		}
		if (userId) for (const row of q.memberRoles.all(userId, grain.id)) roles.add(row.role);
		if (!roles.size) return null;
		return { ...combine(manifest, roles), owner: false };
	}
	const defaultRole = (manifest) => (manifest.roles ?? []).find((r) => r.default)?.id ?? manifest.roles?.[0]?.id ?? "member";

	function appJson(app, extra = {}) {
		const m = manifestOf(app);
		return {
			slug: app.slug,
			name: app.name,
			icon: app.icon,
			summary: app.summary,
			version: app.version,
			permissions: m.permissions ?? [],
			roles: m.roles ?? [],
			defaultRole: defaultRole(m),
			egress: m.egress ?? [],
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

	async function purgeGrain(grain) {
		await celld.deleteSite(grainHost(grain.id));
		db.prepare("DELETE FROM grains WHERE id = ?").run(grain.id);
	}

	// --- tickets and grain sessions ----------------------------------------------------
	function issueTicket(grain, { userId = null, shareId = null, parent = null, path = "/" }) {
		const value = token();
		db.prepare("INSERT INTO tickets (hash, grain_id, user_id, share_id, parent, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			sha256(value),
			grain.id,
			userId,
			shareId,
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
		const access = accessFor(grain, { userId: gs.user_id, shareId: gs.share_id });
		if (!access) return null;
		return { gs, access, user: gs.user_id ? q.user.get(gs.user_id) : null };
	}

	// --- share links -------------------------------------------------------------------
	function shareFromToken(raw) {
		if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return null;
		const share = q.shareByHash.get(sha256(raw));
		if (!share || share.revoked_at) return null;
		const grain = q.grain.get(share.grain_id);
		if (!grain || grain.trashed_at) return null;
		return { share, grain };
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
			if (!installing.size) rmSync(join(tmpDir, name), { recursive: true, force: true });
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
		MAX_SHARES_PER_GRAIN,
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
		combine,
		accessFor,
		defaultRole,
		appJson,
		grainJson,
		storeJson,
		install,
		purgeGrain,
		issueTicket,
		grainVisitor,
		shareFromToken,
		housekeeping,
		close() {
			clearInterval(timer);
			db.close();
		},
	};
}
