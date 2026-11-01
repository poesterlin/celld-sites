// Hamstr's core: configuration, the SQLite store, the access model, the Hamstr
// Store client, tickets and grain sessions. The SvelteKit routes and hooks are
// thin layers over this module; it has no SvelteKit imports, so the test
// harness (and any plain Node script) can drive it directly.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BundleError } from "../../../../packages/app-format/bundle.ts";
import { ManifestError, validateManifest } from "../../../../packages/app-format/manifest.ts";
import { CelldError, createCelld, downloadBundle } from "../../../lib/celld.ts";
import { AuthError, createCore as createAccounts } from "../../../lib/auth/core.ts";
import { safePath } from "../../../lib/path.ts";
import { siteOf } from "../../../lib/site.ts";

export { AuthError, CelldError, ManifestError, BundleError, safePath };

const NAME = "Hamstr";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const GRAIN_SESSION_MS = 12 * 60 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GRAINS_PER_USER = 500;
/** Largest backup Hamstr accepts for a restore or an import. */
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const BACKUP_EXTENSION = "hamstr-backup";

/** -1, 0 or 1 as semver a is older, the same or newer than b (pre-releases
 *  sort before their release). */
function compareVersions(a, b) {
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
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const token = (bytes = 24): string => randomBytes(bytes).toString("base64url");
const now = () => new Date().toISOString();
const strip = (value: unknown): string => String(value ?? "").replace(/\/+$/, "");
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

function parseCookies(header) {
	const out = {};
	for (const part of String(header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i <= 0) continue;
		const key = part.slice(0, i).trim();
		if (key && !(key in out)) out[key] = part.slice(i + 1).trim();
	}
	return out;
}

/** Everything createCore reads from the environment or from tests. */
export interface CoreOptions {
	port?: number | string;
	listenHost?: string;
	dataDir?: string;
	shellHost?: string;
	grainDomain?: string;
	grainPrefix?: string;
	scheme?: string;
	publicPort?: string | number;
	store?: string;
	storePublic?: string;
	celldApi?: string;
	adminHost?: string;
	adminToken?: string;
	proxyToken?: string;
	secret?: string;
	/** Seeds the first sign-in provider on a fresh install; later the Settings page manages providers. */
	oidc?: { issuer: string; clientId: string; clientSecret: string; name?: string };
	/** HMAC key shared with the celld router, so celld sites can sign people in here. */
	authKey?: string;
	/** Before accounts: who was an admin (HAMSTR_ADMINS). Only read to import existing people. */
	admins?: string[];
	grainCookieMode?: string;
	/** "none": home mode. No sign-in: every request is the owner, and each grain
	 *  gets its own port (grainPorts) instead of its own hostname. */
	auth?: string;
	/** Home mode: the port range for grains, e.g. "20000-20999". */
	grainPorts?: string;
	sitesApi?: string;
	logging?: boolean;
}

export function createCore(options: CoreOptions = {}) {
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
			name: env.OIDC_NAME ?? "",
		},
		authKey: options.authKey ?? env.AUTH_KEY ?? "",
		admins: options.admins ?? list(env.HAMSTR_ADMINS),
		auth: String(options.auth ?? env.HAMSTR_AUTH ?? "required"),
		grainPorts: String(options.grainPorts ?? env.HAMSTR_GRAIN_PORTS ?? "20000-20999"),
		logging: options.logging !== false,
	};
	if (!["required", "none"].includes(config.auth)) throw new Error('HAMSTR_AUTH must be "required" or "none"');
	const home = config.auth === "none";
	const portRange = /^(\d+)-(\d+)$/.exec(config.grainPorts);
	if (!portRange || Number(portRange[1]) < 1024 || Number(portRange[2]) > 65535 || Number(portRange[1]) > Number(portRange[2])) {
		throw new Error('HAMSTR_GRAIN_PORTS must be a range like "20000-20999"');
	}
	const [firstPort, lastPort] = [Number(portRange[1]), Number(portRange[2])];
	for (const [key, value] of [
		["ADMIN_TOKEN", config.adminToken],
		["PROXY_TOKEN", config.proxyToken],
		["HAMSTR_SECRET", config.secret],
	]) {
		if (!value) throw new Error(`${key} is required`);
	}
	if (config.authKey && config.authKey.length < 32) throw new Error("AUTH_KEY must be at least 32 characters");
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
		CREATE TABLE IF NOT EXISTS grain_ports (
			grain_id TEXT PRIMARY KEY REFERENCES grains(id) ON DELETE CASCADE, port INTEGER UNIQUE NOT NULL);
		CREATE TABLE IF NOT EXISTS grain_sessions (
			hash TEXT PRIMARY KEY, grain_id TEXT NOT NULL REFERENCES grains(id) ON DELETE CASCADE,
			user_id TEXT, parent TEXT, public_id TEXT NOT NULL,
			created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
	`);
	// Share links were removed: drop their tables and columns from databases that
	// still have them (new databases never create them). Tickets are short-lived,
	// so dropping share_id from them and from grain_sessions loses nothing.
	if (Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0) < 1) {
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
	// Store apps are <publisher>/<app>: remember which one each installed app
	// is, so an update can never swap in someone else's app of the same name.
	if (!db.prepare("SELECT 1 FROM pragma_table_info('apps') WHERE name = 'store_id'").get()) db.exec("ALTER TABLE apps ADD COLUMN store_id TEXT");
	// --- accounts ---------------------------------------------------------------------
	// People, groups, sign-in providers, invites and sessions live in their own
	// database (lib/auth); this one keeps a users row per person for the grains.
	const accounts = createAccounts({
		origin: shellOrigin,
		base: "/auth",
		secret: config.secret,
		key: config.authKey || undefined,
		dbPath: join(config.dataDir, "auth.db"),
		celld: { call: (method, path, body) => celld.call(method, path, body) },
		hideSite: (site) => site.startsWith(config.grainPrefix),
	});
	const seeded = seedAccounts();

	/** A fresh install gets the OIDC provider from the environment, and everyone
	 *  who signed in before accounts existed is brought over (see importLegacyPeople).
	 *  Returns the id of the provider the environment describes, if any. */
	function seedAccounts() {
		const issuer = config.oidc.issuer.replace(/\/$/, "");
		const known = accounts.providersList().find((p) => p.kind === "oidc" && p.issuer === issuer)?.id;
		const pid = known ?? seedProvider();
		if (pid && Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0) < 2) importLegacyPeople(pid);
		return pid ?? null;
	}
	function seedProvider() {
		const { issuer, clientId, clientSecret } = config.oidc;
		if (!issuer || !clientId || !clientSecret) return undefined;
		if (accounts.providersList().some((p) => p.kind !== "passkey")) return undefined;
		const name = config.oidc.name || (/\.ts\.net\/?$/.test(issuer) ? "Tailscale" : new URL(issuer).hostname);
		return accounts.saveProvider("setup", { kind: "oidc", name, issuer, clientId, clientSecret });
	}
	/** Same ids (their grains stay theirs), their identity at `pid`; the earliest
	 *  becomes the owner, HAMSTR_ADMINS decides who else is an admin. */
	function importLegacyPeople(pid: string) {
		const hasOwner = () => accounts.people().some((p) => p.role === "owner");
		for (const u of db.prepare("SELECT * FROM users ORDER BY created_at").all() as any[]) {
			const role = !hasOwner() ? "owner" : matchesLegacyAdmin(u) ? "admin" : "member";
			accounts.importPerson({ id: u.id, name: u.name, email: u.email, pid, subject: u.sub, label: u.login ?? u.email, role });
		}
		// Shell sessions and pending logins now live with the accounts.
		db.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS logins; PRAGMA user_version = 2");
	}
	function matchesLegacyAdmin(user) {
		const names = [user.email, user.login, user.sub].filter(Boolean).map((s) => String(s).toLowerCase());
		return config.admins.some((entry) => entry === "*" || names.includes(entry));
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
		app: db.prepare("SELECT * FROM apps WHERE slug = ?"),
		appByStoreId: db.prepare("SELECT * FROM apps WHERE store_id = ?"),
		grain: db.prepare("SELECT * FROM grains WHERE id = ?"),
	};

	// --- identity --------------------------------------------------------------------
	const isAdmin = (user) => user?.role === "owner" || user?.role === "admin";
	/** What apps see as the user id: stable, but not the IdP's subject or email. */
	const publicUserId = (userId) => createHmac("sha256", config.secret).update(`user:${userId}`).digest("hex").slice(0, 32);

	/** The signed-in person for a shell request. The session is an accounts
	 *  session; the users row here follows the account (name, email). */
	function sessionFor(request) {
		if (home) return homeSession();
		const value = parseCookies(request.headers.get("cookie"))[SHELL_COOKIE];
		if (!value || value.length > 200) return null;
		const found = accounts.sessionUser(value);
		if (!found) return null;
		return sessionOf(found.user, found.sessionId, value);
	}
	/** Home mode: every request is the owner, with no cookie and no session row. */
	function homeSession() {
		return sessionOf(accounts.homeOwner(), "home", "");
	}
	function sessionOf(a, sessionId, value) {
		const login = accounts.person(a.id).identities[0]?.label ?? null;
		const row = q.user.get(a.id);
		if (!row) {
			db.prepare("INSERT INTO users (id, sub, name, email, login, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.id, `account:${a.id}`, a.name, a.email, login, now(), now());
		} else if (row.name !== a.name || row.email !== a.email || Date.parse(String(row.seen_at)) < Date.now() - 60_000) {
			db.prepare("UPDATE users SET name = ?, email = ?, seen_at = ? WHERE id = ?").run(a.name, a.email, now(), a.id);
		}
		return { hash: sessionId, token: value, user: { id: a.id, name: a.name, email: a.email, login, role: a.role } };
	}
	const sessionCookie = (value: string, maxAge: number) => `${SHELL_COOKIE}=${value}; ${cookieAttrs}; Max-Age=${maxAge}`;

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
			storeId: app.store_id ?? null,
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
			devices: m.devices ?? [],
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
			// Home mode: the grain's port on whatever host the browser uses, so no fixed origin.
			origin: home ? null : grainOrigin(grain.id),
			...(access && { role: access.role, permissions: access.permissions, isOwner: access.owner }),
			...extra,
		};
	}

	// --- store ---------------------------------------------------------------------
	async function storeJson(path) {
		if (!config.store) throw new HttpError(503, "no app store is set up: set HAMSTR_STORE (in the Home Assistant add-on: the App store option)");
		let res;
		try {
			res = await fetch(`${config.store}${path}`, { signal: AbortSignal.timeout(30_000) });
		} catch {
			throw new HttpError(502, "the app store is unreachable");
		}
		const text = await res.text();
		let body: any = {};
		try {
			body = JSON.parse(text);
		} catch {}
		if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, body.error || `the store answered ${res.status}`);
		return body;
	}

	const storePath = (id) => String(id).split("/").map(encodeURIComponent).join("/");

	/** Which store app an installed app from before namespaces is. The store
	 *  answers bare names only for apps that existed then, so a new
	 *  "someone/<name>" can never claim it. */
	async function legacyStoreId(slug) {
		try {
			return (await storeJson(`/api/v1/apps/${encodeURIComponent(slug)}`)).app?.id ?? null;
		} catch {
			return null;
		}
	}
	async function backfillStoreIds() {
		for (const row of db.prepare("SELECT slug FROM apps WHERE store_id IS NULL").all()) {
			const id = await legacyStoreId(row.slug);
			if (id && id.split("/").pop() === row.slug) db.prepare("UPDATE apps SET store_id = ? WHERE slug = ? AND store_id IS NULL").run(id, row.slug);
		}
	}

	/** Install or update an app (`id` is the store's <publisher>/<app>); updates
	 *  move every grain of it to the new code. Locally an app goes by its own
	 *  name, so one Hamstr holds one app of each name. */
	const installing = new Map();
	async function install(id, { version, allowEgress, user }) {
		if (installing.has(id)) throw new HttpError(409, `${id} is already being installed`);
		const job = (async () => {
			const detail: any = await storeJson(`/api/v1/apps/${storePath(id)}`);
			// The store's name for it (an old bare name redirects to it).
			const storeId = String(detail.app?.id ?? id);
			const releases = (detail.releases ?? []).filter((r) => r.status === "published");
			const release = version ? releases.find((r) => r.version === version) : releases[0];
			if (!release) throw new HttpError(404, version ? `${storeId}@${version} is not published` : `${storeId} has no published release`);
			let manifest;
			try {
				manifest = validateManifest(release.manifest);
			} catch (err) {
				throw new HttpError(422, `the store's manifest is invalid: ${err.message}`);
			}
			if (manifest.slug !== storeId.split("/").pop()) throw new HttpError(422, "the release manifest is for another app");
			const slug = manifest.slug;
			const existing = q.app.get(slug);
			if (existing) {
				const owner = existing.store_id ?? (await legacyStoreId(slug));
				if (owner !== storeId) {
					throw new HttpError(409, `this Hamstr already has an app called ${existing.name}${owner ? ` (${owner})` : ""}; remove it before getting ${storeId}`);
				}
			}
			const oldEgress = existing ? (manifestOf(existing).egress ?? []) : [];
			const newEgress = manifest.egress ?? [];
			const oldDevices = existing ? (manifestOf(existing).devices ?? []) : [];
			const newDevices = (manifest.devices ?? []).filter((d) => !oldDevices.includes(d));
			// `allowEgress` is the admin's consent to everything the install dialog listed: hosts and devices.
			if (newEgress.some((h) => !oldEgress.includes(h)) && !allowEgress) {
				throw new HttpError(403, `${manifest.name} wants network access to ${newEgress.join(", ")}; review and allow it first`);
			}
			if (newDevices.length && !allowEgress) {
				throw new HttpError(403, `${manifest.name} wants to use the ${newDevices.join(", ")}; review and allow it first`);
			}
			const { file, sha } = await downloadBundle(config.store, storeId, release.version, release.bundleSha256, tmpDir);
			let uploaded;
			try {
				uploaded = await celld.upload(file, { egress: newEgress, probeHost: `${config.grainPrefix}probe-${randomId(8)}.${config.grainDomain}` });
			} finally {
				rmSync(file, { force: true });
			}
			const stamp = now();
			if (existing) {
				db.prepare(
					"UPDATE apps SET name = ?, icon = ?, summary = ?, version = ?, code_version = ?, bundle_sha = ?, manifest = ?, updated_at = ?, store_id = ? WHERE slug = ?",
				).run(manifest.name, manifest.icon, manifest.summary, manifest.version, uploaded.version, sha, JSON.stringify(manifest), stamp, storeId, slug);
			} else {
				db.prepare(
					"INSERT INTO apps (slug, store_id, name, icon, summary, version, code_version, bundle_sha, manifest, installed_by, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(slug, storeId, manifest.name, manifest.icon, manifest.summary, manifest.version, uploaded.version, sha, JSON.stringify(manifest), user.id, stamp, stamp);
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
		installing.set(id, job);
		try {
			return await job;
		} finally {
			installing.delete(id);
		}
	}

	/** A new grain of an installed app, as its own celld site. */
	async function createGrain(user: any, app: any, title = ""): Promise<any> {
		if (Number(db.prepare("SELECT COUNT(*) AS n FROM grains WHERE owner_id = ?").get(user.id)?.n ?? 0) >= MAX_GRAINS_PER_USER) {
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

	/** Wipe a grain's data and start it empty again, on the app's current code.
	 *  The item keeps its id, title and place; everything it stored is gone. Like
	 *  a restore it takes a safety copy first and puts the data back if it fails. */
	async function resetGrain(grain) {
		const app = q.app.get(grain.slug);
		if (!app) throw new HttpError(409, "the app of this item is not installed");
		if (restoring.has(grain.id)) throw new HttpError(409, "this item is already being restored or reset");
		const host = grainHost(grain.id);
		const egress = manifestOf(app).egress ?? [];
		restoring.add(grain.id);
		const safety = tempFile("before-reset");
		try {
			try {
				await celld.dumpTo(host, safety);
			} catch (err) {
				throw new HttpError(502, `could not take a safety copy of the current data first, so nothing was changed (${err.message})`);
			}
			try {
				await celld.deleteSite(host);
				await celld.deployGrain(host, String(app.code_version), egress);
			} catch (err) {
				try {
					await celld.deployGrain(host, grain.code_version, egress);
					const back = await celld.restoreFrom(host, safety);
					if (back.status !== 200) throw new Error(back.json?.error ?? `status ${back.status}`);
				} catch (backErr) {
					throw new HttpError(502, `the reset failed (${err.message}), and putting the previous data back failed too (${backErr.message}); the item may be incomplete`);
				}
				throw new HttpError(502, `the reset failed (${err.message}); the item was put back as it was`);
			}
			db.prepare("UPDATE grains SET code_version = ? WHERE id = ?").run(app.code_version, grain.id);
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
		portHooks.close(grain.id);
	}

	/** What uninstalling an app would delete, as seen by `user`. */
	function usage(slug, user) {
		const row = db
			.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(owner_id = ?), 0) AS mine, COUNT(DISTINCT owner_id) AS owners FROM grains WHERE slug = ?")
			.get(user.id, slug);
		const total = Number(row.total);
		const mine = Number(row.mine);
		return { items: total, mine, others: total - mine, people: Number(row.owners) };
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
	/** Home mode: the grain's port, given out on first use and kept. */
	function grainPort(id) {
		const row = db.prepare("SELECT port FROM grain_ports WHERE grain_id = ?").get(id);
		if (row) return Number(row.port);
		const taken = new Set(db.prepare("SELECT port FROM grain_ports").all().map((r) => Number(r.port)));
		let port = firstPort;
		while (taken.has(port)) port++;
		if (port > lastPort) throw new HttpError(503, `all ${lastPort - firstPort + 1} grain ports (${config.grainPorts}) are in use`);
		db.prepare("INSERT INTO grain_ports (grain_id, port) VALUES (?, ?)").run(id, port);
		portHooks.open(id, port);
		return port;
	}
	/** server.ts listens on grain ports; it sets these once it runs. */
	const portHooks = { open: (_id: string, _port: number) => {}, close: (_id: string) => {} };
	const grainPorts = () => db.prepare("SELECT grain_id AS id, port FROM grain_ports").all().map((r) => ({ id: String(r.id), port: Number(r.port) }));

	/** Where the browser opens a grain. Normally a one-time ticket on the grain's
	 *  hostname; in home mode the grain's port on the hostname the browser used
	 *  for the shell (`host`), with no handshake: nobody signs in. */
	function issueTicket(grain, { userId, parent = null, path = "/", host = "" }) {
		if (home) {
			db.prepare("UPDATE grains SET opened_at = ? WHERE id = ?").run(now(), grain.id);
			const hostname = String(host).replace(/:\d+$/, "") || "localhost";
			return `http://${hostname}:${grainPort(grain.id)}${safePath(path)}`;
		}
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
		if (home) {
			// Everyone who reaches the grain's port is its owner.
			const access = accessFor(grain, { userId: grain.owner_id });
			if (!access) return null;
			return { gs: { public_id: createHmac("sha256", config.secret).update(`home:${grain.id}`).digest("hex").slice(0, 16) }, access, user: q.user.get(grain.owner_id) };
		}
		const value = parseCookies(request.headers.get("cookie"))[GRAIN_COOKIE];
		if (!value || value.length > 200) return null;
		const gs = db.prepare("SELECT * FROM grain_sessions WHERE hash = ? AND expires_at > ?").get(sha256(value), Date.now());
		if (!gs || gs.grain_id !== grain.id) return null;
		if (gs.parent && !accounts.sessionAlive(String(gs.parent))) return null;
		const access = accessFor(grain, { userId: gs.user_id });
		if (!access) return null;
		return { gs, access, user: gs.user_id ? q.user.get(gs.user_id) : null };
	}

	// --- housekeeping ------------------------------------------------------------------
	async function housekeeping() {
		const t = Date.now();
		accounts.sweep();
		db.prepare("DELETE FROM grain_sessions WHERE expires_at < ?").run(t);
		db.prepare("DELETE FROM tickets WHERE expires_at < ?").run(t);
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
	// Apps installed before namespaces learn their <publisher>/<app> from the store.
	if (config.store) setTimeout(() => backfillStoreIds().catch(() => {}), 2000).unref();

	return {
		NAME,
		config,
		db,
		celld,
		accounts,
		seededProvider: seeded,
		tmpDir,
		sitesApi,
		shellOrigin,
		grainHost,
		grainOrigin,
		grainPattern,
		// Home mode: grains are other ports of whatever host the browser uses.
		grainSources: home ? "http:" : `${config.scheme}://*.${config.grainDomain}${portSuffix}`,
		home,
		grainPorts,
		portHooks,
		SHELL_COOKIE,
		GRAIN_COOKIE,
		cookieAttrs,
		grainCookieAttrs,
		sessionCookie,
		GRAIN_SESSION_MS,
		TICKET_MS,
		TRASH_MS,
		MAX_GRAINS_PER_USER,
		MAX_BACKUP_BYTES,
		BACKUP_EXTENSION,
		tempFile,
		releaseTemp,
		backupGrain,
		restoreGrain,
		resetGrain,
		importBackup,
		isRestoring,
		sha256,
		token,
		now,
		randomId,
		tx,
		q,
		isAdmin,
		publicUserId,
		sessionFor,
		manifestOf,
		accessFor,
		appJson,
		grainJson,
		storeJson,
		storePath,
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
			accounts.db.close();
		},
	};
}
