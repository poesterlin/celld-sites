// Hamstr: a personal app platform in the spirit of Sandstorm, on a celld node.
//
// Apps come from the Cubby store. Every document, board or list you make with an
// app is a *grain*: its own celld site at grain-<id>.<domain>, with its own
// Durable Objects (its data) and no network unless the app declared egress and
// an admin allowed it. Apps never implement sign-in. Hamstr authenticates the
// visitor (tsidp OIDC, or a share link), then proxies the grain's requests to
// celld with identity headers (X-Hamstr-User-Id, -Username, -Permissions,
// -Role). The router serves grain sites only to this proxy (PROXY_TOKEN), and
// the proxy drops identity headers sent by the browser, so an app can trust them.
//
// One process answers two kinds of hostname:
//   HAMSTR_HOST            the shell: UI, JSON API, sign-in, share links
//   grain-<id>.<domain>    a grain: /.hamstr/enter, then everything is proxied
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ManifestError, validateManifest } from "../cubby/lib/manifest.mjs";
import { BundleError } from "../cubby/lib/bundle.mjs";
import { CelldError, createCelld, downloadBundle } from "./lib/celld.mjs";
import { OidcError, createOidc, pkce } from "./lib/oidc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const NAME = "Hamstr";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const GRAIN_ID = /^[a-z0-9]{12}$/;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const GRAIN_SESSION_MS = 12 * 60 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const LOGIN_MS = 10 * 60 * 1000;
const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_GRAINS_PER_USER = 500;
const MAX_SHARES_PER_GRAIN = 50;

class HttpError extends Error {
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
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

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

/** A path inside a grain that is safe to redirect to: absolute, one leading slash. */
function safePath(value) {
	const path = String(value ?? "/");
	if (!path.startsWith("/") || path.startsWith("//") || path.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(path)) return "/";
	return path;
}

/** The registrable domain, approximately: the last two labels. Single-label and
 *  *.localhost names are their own site, as browsers treat them. */
export function siteOf(host) {
	const labels = String(host).split(".");
	if (labels.length < 2 || labels[labels.length - 1] === "localhost") return host;
	return labels.slice(-2).join(".");
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

export function createHamstr(options = {}) {
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

	function currentSession(req) {
		const value = parseCookies(req.headers.cookie)[SHELL_COOKIE];
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
	function grainVisitor(req, grain) {
		const value = parseCookies(req.headers.cookie)[GRAIN_COOKIE];
		if (!value || value.length > 200) return null;
		const gs = db.prepare("SELECT * FROM grain_sessions WHERE hash = ? AND expires_at > ?").get(sha256(value), Date.now());
		if (!gs || gs.grain_id !== grain.id) return null;
		if (gs.parent && !db.prepare("SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?").get(gs.parent, Date.now())) return null;
		const access = accessFor(grain, { userId: gs.user_id, shareId: gs.share_id });
		if (!access) return null;
		return { gs, access, user: gs.user_id ? q.user.get(gs.user_id) : null };
	}

	// --- HTTP helpers ----------------------------------------------------------------
	const grainSources = `${config.scheme}://*.${config.grainDomain}${portSuffix}`;
	const SHELL_HEADERS = {
		"x-content-type-options": "nosniff",
		// Chromium sends `Origin: null` on form posts under no-referrer, which would
		// defeat the same-origin checks below.
		"referrer-policy": "same-origin",
		"x-frame-options": "DENY",
		"content-security-policy": [
			"default-src 'self'",
			"img-src 'self' data:",
			"style-src 'self'",
			"script-src 'self'",
			"connect-src 'self'",
			`frame-src ${grainSources}`,
			"base-uri 'none'",
			// Chromium applies form-action to the redirect after a POST too, and
			// "Open as guest" redirects into the grain.
			`form-action 'self' ${grainSources}`,
			"frame-ancestors 'none'",
		].join("; "),
	};
	function json(res, status, body, extra = {}) {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			...SHELL_HEADERS,
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store",
			...extra,
		});
		res.end(payload);
	}
	const fail = (res, status, message) => json(res, status, { error: message });
	function html(res, status, body, extra = {}) {
		res.writeHead(status, { ...SHELL_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra });
		res.end(body);
	}
	const redirect = (res, location, extra = {}) => res.writeHead(303, { location, "cache-control": "no-store", ...extra }).end();

	async function readBody(req, limit = 64 * 1024) {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit) throw new HttpError(413, "request is too large");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	async function readJson(req) {
		if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
		try {
			return JSON.parse((await readBody(req)) || "{}");
		} catch (err) {
			if (err instanceof HttpError) throw err;
			throw new HttpError(400, "body is not JSON");
		}
	}
	/** Unsafe requests to the shell must come from the shell's own pages. */
	const sameOrigin = (req) => {
		const site = req.headers["sec-fetch-site"];
		if (site !== undefined) return site === "same-origin";
		const origin = req.headers.origin;
		return origin === undefined || origin === shellOrigin;
	};

	function serveFile(req, res, name, cache = "no-cache") {
		const file = resolve(join(PUBLIC_DIR, name));
		if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file)) return false;
		const body = readFileSync(file);
		res.writeHead(200, { ...SHELL_HEADERS, "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": body.length, "cache-control": cache });
		res.end(req.method === "HEAD" ? undefined : body);
		return true;
	}

	function page(title, body) {
		return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${NAME}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"></head>
<body class="plain"><main class="center-card">${body}</main></body></html>`;
	}

	// --- shell: sign-in -------------------------------------------------------------
	async function startLogin(res, next) {
		const state = token(18);
		const nonce = token(18);
		const { verifier, challenge } = pkce();
		db.prepare("INSERT INTO logins (state, nonce, verifier, next, created_at) VALUES (?, ?, ?, ?, ?)").run(state, nonce, verifier, safePath(next), Date.now());
		redirect(res, await oidc.authorizationUrl({ state, nonce, challenge }));
	}

	async function finishLogin(req, res, url) {
		const state = url.searchParams.get("state") ?? "";
		const login = db.prepare("DELETE FROM logins WHERE state = ? RETURNING *").get(state);
		if (!login || login.created_at < Date.now() - LOGIN_MS) {
			return html(res, 400, page("Sign-in expired", `<h1>That sign-in expired</h1><p class="dim">Please start again.</p><p><a class="button" href="/auth/login">Sign in</a></p>`));
		}
		if (url.searchParams.get("error")) {
			return html(res, 403, page("Sign-in cancelled", `<h1>Sign-in didn't finish</h1><p class="dim">${esc(url.searchParams.get("error"))}</p><p><a class="button" href="/auth/login">Try again</a></p>`));
		}
		let claims;
		try {
			claims = await oidc.finish({ code: url.searchParams.get("code") ?? "", verifier: login.verifier, nonce: login.nonce });
		} catch (err) {
			if (!(err instanceof OidcError)) throw err;
			console.error("hamstr: sign-in failed", err.message);
			return html(res, 502, page("Sign-in failed", `<h1>Sign-in failed</h1><p class="dim">${esc(err.message)}</p><p><a class="button" href="/auth/login">Try again</a></p>`));
		}
		const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
		const handle = typeof claims.username === "string" ? claims.username : typeof claims.preferred_username === "string" ? claims.preferred_username : null;
		const profile = { sub: claims.sub, email, login: handle };
		if (config.allowed.length && !matches(config.allowed, profile) && !matches(config.admins, profile)) {
			return html(res, 403, page("Not invited", `<h1>You're not on the list</h1><p class="dim">This ${NAME} only lets in invited people. Ask its owner to add ${esc(email ?? handle ?? "you")}.</p>`));
		}
		const name = String(claims.name || handle || (email ? email.split("@")[0] : "") || "Someone").slice(0, 80);
		const user = tx(() => {
			const existing = q.userBySub.get(claims.sub);
			if (existing) {
				db.prepare("UPDATE users SET name = ?, email = ?, login = ?, seen_at = ? WHERE id = ?").run(name, email, handle, now(), existing.id);
				return existing;
			}
			const id = randomId(16);
			db.prepare("INSERT INTO users (id, sub, name, email, login, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, claims.sub, name, email, handle, now(), now());
			return { id };
		});
		const value = token(32);
		db.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(value), user.id, Date.now(), Date.now() + SESSION_MS);
		redirect(res, login.next, { "set-cookie": `${SHELL_COOKIE}=${value}; ${cookieAttrs}; Max-Age=${SESSION_MS / 1000}` });
	}

	// --- shell: share links ----------------------------------------------------------
	function shareFromToken(raw) {
		if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return null;
		const share = q.shareByHash.get(sha256(raw));
		if (!share || share.revoked_at) return null;
		const grain = q.grain.get(share.grain_id);
		if (!grain || grain.trashed_at) return null;
		return { share, grain };
	}

	function shareLanding(req, res, raw) {
		const found = shareFromToken(raw);
		if (!found) {
			return html(res, 404, page("Link not working", `<div class="logo-lg">${LOGO}</div><h1>This link doesn't work anymore</h1><p class="dim">It may have been turned off by the person who shared it.</p>`));
		}
		const { share, grain } = found;
		const session = currentSession(req);
		if (session) {
			if (grain.owner_id !== session.user.id) {
				db.prepare("INSERT OR IGNORE INTO members (share_id, user_id, joined_at) VALUES (?, ?, ?)").run(share.id, session.user.id, now());
			}
			return redirect(res, `/g/${grain.id}`);
		}
		const app = q.app.get(grain.slug);
		const owner = q.user.get(grain.owner_id);
		const role = combine(manifestOf(app), new Set([share.role]));
		const roleTitle = (manifestOf(app)?.roles ?? []).find((r) => r.id === role.role)?.title ?? "Full access";
		return html(
			res,
			200,
			page(
				grain.title,
				`<div class="logo-lg">${LOGO}</div>
<p class="dim">${esc(owner?.name ?? "Someone")} shared</p>
<h1><span class="app-icon">${esc(app?.icon ?? "")}</span> ${esc(grain.title)}</h1>
<p class="dim">${esc(app?.name ?? grain.slug)} · ${esc(roleTitle)}</p>
<div class="stack">
	<a class="button" href="/auth/login?next=${encodeURIComponent(`/s/${raw}`)}">Sign in to keep it</a>
	<form method="post" action="/s/${esc(raw)}/open"><button class="button ghost" type="submit">Open as guest</button></form>
</div>`,
			),
			{ "referrer-policy": "no-referrer" },
		);
	}

	// --- shell: JSON API ----------------------------------------------------------------
	async function api(req, res, method, pathname, url, session) {
		if (!session) return fail(res, 401, "sign in first");
		if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) return fail(res, 403, "cross-origin request");
		const me = session.user;
		const admin = isAdmin(me);

		if (pathname === "/api/me" && method === "GET") {
			return json(res, 200, {
				user: { id: me.id, name: me.name, email: me.email, admin },
				config: { name: NAME, grainDomain: config.grainDomain, storePublic: config.storePublic },
			});
		}

		// Installed apps.
		if (pathname === "/api/apps" && method === "GET") {
			const counts = new Map(db.prepare("SELECT slug, COUNT(*) AS n FROM grains GROUP BY slug").all().map((r) => [r.slug, r.n]));
			const apps = db.prepare("SELECT * FROM apps ORDER BY name COLLATE NOCASE").all();
			return json(res, 200, { apps: apps.map((a) => appJson(a, { grains: counts.get(a.slug) ?? 0 })) });
		}
		if (pathname === "/api/apps/updates" && method === "GET") {
			const apps = db.prepare("SELECT slug, version FROM apps").all();
			const updates = {};
			await Promise.all(
				apps.map(async (a) => {
					try {
						const detail = await storeJson(`/api/v1/apps/${encodeURIComponent(a.slug)}`);
						const latest = (detail.releases ?? []).find((r) => r.status === "published");
						if (latest && latest.version !== a.version) updates[a.slug] = { version: latest.version, egress: latest.manifest?.egress ?? [] };
					} catch {}
				}),
			);
			return json(res, 200, { updates });
		}
		if (pathname === "/api/apps" && method === "POST") {
			if (!admin) return fail(res, 403, "only an admin can install apps");
			const body = await readJson(req);
			const slug = String(body.slug ?? "");
			if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(slug)) return fail(res, 400, "bad app id");
			const version = body.version === undefined ? undefined : String(body.version);
			return json(res, 200, await install(slug, { version, allowEgress: body.allowEgress === true, user: me }));
		}
		const appOp = /^\/api\/apps\/([a-z0-9-]+)$/.exec(pathname);
		if (appOp && method === "DELETE") {
			if (!admin) return fail(res, 403, "only an admin can remove apps");
			const app = q.app.get(appOp[1]);
			if (!app) return fail(res, 404, "that app is not installed");
			const n = db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ?").get(app.slug).n;
			if (n) return fail(res, 409, `${app.name} still has ${n} grain${n === 1 ? "" : "s"} (including the trash); delete them first`);
			db.prepare("DELETE FROM apps WHERE slug = ?").run(app.slug);
			return json(res, 200, { ok: true });
		}

		// The store, read through the shell so the browser talks to one origin.
		if (pathname === "/api/market" && method === "GET") {
			const params = new URLSearchParams();
			for (const key of ["q", "tag", "limit", "offset"]) if (url.searchParams.get(key)) params.set(key, url.searchParams.get(key).slice(0, 100));
			return json(res, 200, await storeJson(`/api/v1/apps${params.size ? `?${params}` : ""}`));
		}
		const marketApp = /^\/api\/market\/([a-z0-9-]+)$/.exec(pathname);
		if (marketApp && method === "GET") return json(res, 200, await storeJson(`/api/v1/apps/${marketApp[1]}`));

		// Grains.
		if (pathname === "/api/grains" && method === "GET") {
			const mine = db.prepare("SELECT * FROM grains WHERE owner_id = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id);
			const shared = db
				.prepare(
					"SELECT DISTINCT g.* FROM members m JOIN shares s ON s.id = m.share_id JOIN grains g ON g.id = s.grain_id WHERE m.user_id = ? AND s.revoked_at IS NULL AND g.trashed_at IS NULL AND g.owner_id != ? ORDER BY COALESCE(g.opened_at, g.created_at) DESC",
				)
				.all(me.id, me.id);
			const shareCounts = new Map(
				db.prepare("SELECT grain_id, COUNT(*) AS n FROM shares WHERE revoked_at IS NULL AND created_by = ? GROUP BY grain_id").all(me.id).map((r) => [r.grain_id, r.n]),
			);
			return json(res, 200, {
				mine: mine.filter((g) => !g.trashed_at).map((g) => grainJson(g, accessFor(g, { userId: me.id }), { shared: (shareCounts.get(g.id) ?? 0) > 0 })),
				shared: shared.map((g) => grainJson(g, accessFor(g, { userId: me.id }))),
				trash: mine.filter((g) => g.trashed_at).map((g) => grainJson(g, null)),
			});
		}
		if (pathname === "/api/grains" && method === "POST") {
			const body = await readJson(req);
			const app = q.app.get(String(body.slug ?? ""));
			if (!app) return fail(res, 404, "that app is not installed");
			const title = String(body.title ?? "").trim().slice(0, 80) || `Untitled ${app.name}`;
			if (db.prepare("SELECT COUNT(*) AS n FROM grains WHERE owner_id = ?").get(me.id).n >= MAX_GRAINS_PER_USER) {
				return fail(res, 403, `you can have at most ${MAX_GRAINS_PER_USER} grains`);
			}
			const id = randomId(12);
			try {
				await celld.deployGrain(grainHost(id), app.code_version, manifestOf(app).egress ?? []);
			} catch (err) {
				await celld.deleteSite(grainHost(id)).catch(() => {});
				throw err;
			}
			db.prepare("INSERT INTO grains (id, slug, title, owner_id, code_version, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, app.slug, title, me.id, app.code_version, now());
			const grain = q.grain.get(id);
			return json(res, 201, { grain: grainJson(grain, accessFor(grain, { userId: me.id })) });
		}

		const grainOp = /^\/api\/grains\/([a-z0-9]{12})(?:\/(open|trash|restore|leave|shares))?$/.exec(pathname);
		if (grainOp) {
			const grain = q.grain.get(grainOp[1]);
			if (!grain) return fail(res, 404, "no such grain");
			const owner = grain.owner_id === me.id;
			const action = grainOp[2];
			if (!action && method === "GET") {
				const access = accessFor(grain, { userId: me.id });
				if (!access && !(owner && grain.trashed_at)) return fail(res, 404, "no such grain");
				const app = q.app.get(grain.slug);
				return json(res, 200, { grain: grainJson(grain, access), app: app ? appJson(app) : null });
			}
			if (action === "open" && method === "POST") {
				const access = accessFor(grain, { userId: me.id });
				if (!access) return fail(res, 404, "no such grain");
				const body = await readJson(req);
				return json(res, 200, { url: issueTicket(grain, { userId: me.id, parent: session.hash, path: body.path }) });
			}
			if (action === "leave" && method === "POST") {
				db.prepare("DELETE FROM members WHERE user_id = ? AND share_id IN (SELECT id FROM shares WHERE grain_id = ?)").run(me.id, grain.id);
				return json(res, 200, { ok: true });
			}
			if (!owner) return fail(res, grain.trashed_at || !accessFor(grain, { userId: me.id }) ? 404 : 403, "only the owner can do that");
			if (!action && method === "PATCH") {
				const body = await readJson(req);
				const title = String(body.title ?? "").trim().slice(0, 80);
				if (!title) return fail(res, 400, "a title is required");
				db.prepare("UPDATE grains SET title = ? WHERE id = ?").run(title, grain.id);
				return json(res, 200, { grain: grainJson(q.grain.get(grain.id), accessFor(grain, { userId: me.id })) });
			}
			if (action === "trash" && method === "POST") {
				db.prepare("UPDATE grains SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL").run(now(), grain.id);
				db.prepare("DELETE FROM grain_sessions WHERE grain_id = ?").run(grain.id);
				return json(res, 200, { ok: true });
			}
			if (action === "restore" && method === "POST") {
				db.prepare("UPDATE grains SET trashed_at = NULL WHERE id = ?").run(grain.id);
				return json(res, 200, { ok: true });
			}
			if (!action && method === "DELETE") {
				if (!grain.trashed_at) return fail(res, 409, "move the grain to the trash first");
				await purgeGrain(grain);
				return json(res, 200, { ok: true });
			}
			if (action === "shares" && method === "GET") {
				const rows = db
					.prepare(
						"SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.share_id = s.id) AS people FROM shares s WHERE s.grain_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC",
					)
					.all(grain.id);
				return json(res, 200, { shares: rows.map((s) => ({ id: s.id, role: s.role, label: s.label, createdAt: s.created_at, people: s.people })) });
			}
			if (action === "shares" && method === "POST") {
				if (grain.trashed_at) return fail(res, 409, "restore the grain before sharing it");
				const manifest = manifestOf(q.app.get(grain.slug));
				const body = await readJson(req);
				const roles = manifest.roles ?? [];
				const role = roles.length ? String(body.role ?? defaultRole(manifest)) : "member";
				if (roles.length && !roles.some((r) => r.id === role)) return fail(res, 400, "that role does not exist in this app");
				if (db.prepare("SELECT COUNT(*) AS n FROM shares WHERE grain_id = ? AND revoked_at IS NULL").get(grain.id).n >= MAX_SHARES_PER_GRAIN) {
					return fail(res, 403, `at most ${MAX_SHARES_PER_GRAIN} active links per grain`);
				}
				const raw = token(24);
				const id = randomId(12);
				const label = String(body.label ?? "").trim().slice(0, 60);
				db.prepare("INSERT INTO shares (id, hash, grain_id, role, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
					id,
					sha256(raw),
					grain.id,
					role,
					label,
					me.id,
					now(),
				);
				// The link is shown once; only its hash is stored.
				return json(res, 201, { share: { id, role, label, createdAt: now(), people: 0 }, url: `${shellOrigin}/s/${raw}` });
			}
		}
		const shareOp = /^\/api\/shares\/([a-z0-9]{12})$/.exec(pathname);
		if (shareOp && method === "DELETE") {
			const share = q.share.get(shareOp[1]);
			const grain = share && q.grain.get(share.grain_id);
			if (!share || !grain || grain.owner_id !== me.id) return fail(res, 404, "no such link");
			tx(() => {
				db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(now(), share.id);
				db.prepare("DELETE FROM grain_sessions WHERE share_id = ?").run(share.id);
				db.prepare("DELETE FROM tickets WHERE share_id = ?").run(share.id);
			});
			return json(res, 200, { ok: true });
		}
		return fail(res, 404, "no such endpoint");
	}

	// --- shell routing ------------------------------------------------------------------
	const SPA = /^\/(?:|apps|shared|trash|g\/[a-z0-9]{12})$/;
	async function shell(req, res, method, pathname, url) {
		if (pathname === "/api/health") return json(res, 200, { ok: true });
		if (pathname === "/style.css" || pathname === "/app.js" || pathname === "/favicon.svg") {
			if (method === "GET" || method === "HEAD") return void serveFile(req, res, pathname.slice(1));
		}
		const session = currentSession(req);
		if (pathname === "/auth/login" && method === "GET") return startLogin(res, url.searchParams.get("next") ?? "/");
		if (pathname === "/auth/callback" && method === "GET") return finishLogin(req, res, url);
		if (pathname === "/auth/logout" && method === "POST") {
			if (!sameOrigin(req)) return fail(res, 403, "cross-origin sign-out");
			if (session) db.prepare("DELETE FROM sessions WHERE hash = ?").run(session.hash);
			return redirect(res, "/", { "set-cookie": `${SHELL_COOKIE}=; ${cookieAttrs}; Max-Age=0` });
		}
		const share = /^\/s\/([A-Za-z0-9_-]{1,100})(\/open)?$/.exec(pathname);
		if (share && !share[2] && method === "GET") return shareLanding(req, res, share[1]);
		if (share && share[2] && method === "POST") {
			if (!sameOrigin(req)) return fail(res, 403, "cross-origin request");
			const found = shareFromToken(share[1]);
			if (!found) return shareLanding(req, res, share[1]);
			return redirect(res, issueTicket(found.grain, { shareId: found.share.id }), { "referrer-policy": "no-referrer" });
		}
		// Open a grain at top level (new tab, or recovering an expired grain session).
		const openTop = /^\/g\/([a-z0-9]{12})\/open$/.exec(pathname);
		if (openTop && method === "GET") {
			if (!session) return redirect(res, `/auth/login?next=${encodeURIComponent(`${pathname}${url.search}`)}`);
			const grain = q.grain.get(openTop[1]);
			if (!accessFor(grain, { userId: session.user.id })) return html(res, 404, page("Not found", `<h1>No such grain</h1><p><a class="button" href="/">Home</a></p>`));
			return redirect(res, issueTicket(grain, { userId: session.user.id, parent: session.hash, path: url.searchParams.get("path") ?? "/" }));
		}
		if (pathname.startsWith("/api/")) return api(req, res, method, pathname, url, session);
		if ((method === "GET" || method === "HEAD") && SPA.test(pathname)) return void serveFile(req, res, "index.html");
		return html(res, 404, page("Not found", `<h1>Not found</h1><p><a class="button" href="/">Home</a></p>`));
	}

	// --- grain hosts: the proxy ---------------------------------------------------------
	function grainNotice(res, status, grain, message) {
		const target = `${shellOrigin}/g/${grain.id}`;
		res.writeHead(status, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${shellOrigin}`,
			"x-content-type-options": "nosniff",
		});
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#18181b;background:#f4f4f6}
a{color:#5452e8}@media(prefers-color-scheme:dark){body{color:#f4f4f6;background:#0c0c10}a{color:#7c7bff}}</style>
<p>${esc(message)} <a href="${esc(target)}" target="_top">Open it in ${NAME}</a></p>`);
	}

	async function grainRequest(req, res, grainId) {
		const grain = q.grain.get(grainId);
		if (!grain || grain.trashed_at) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("No such grain\n");
			return;
		}
		const rawPath = req.url ?? "/";
		if (!rawPath.startsWith("/")) {
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request target\n");
			return;
		}
		const pathname = rawPath.split("?")[0];
		const fetchSite = req.headers["sec-fetch-site"];
		const navigate = req.headers["sec-fetch-mode"] === "navigate";

		if (pathname === "/.hamstr/enter") {
			const params = new URLSearchParams(rawPath.slice(pathname.length + 1));
			const value = params.get("ticket") ?? "";
			const ticket = db.prepare("DELETE FROM tickets WHERE hash = ? RETURNING *").get(sha256(value));
			if (!ticket || ticket.grain_id !== grain.id || ticket.expires_at < Date.now()) return grainNotice(res, 403, grain, "This link to the grain has expired.");
			const sessionValue = token(32);
			db.prepare(
				"INSERT INTO grain_sessions (hash, grain_id, user_id, share_id, parent, public_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(sha256(sessionValue), grain.id, ticket.user_id, ticket.share_id, ticket.parent, randomId(16), Date.now(), Date.now() + GRAIN_SESSION_MS);
			res.writeHead(303, {
				location: ticket.path,
				"set-cookie": `${GRAIN_COOKIE}=${sessionValue}; ${grainCookieAttrs}; Max-Age=${GRAIN_SESSION_MS / 1000}`,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			res.end();
			return;
		}
		if (pathname.startsWith("/.hamstr/")) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
			return;
		}

		// Other sites, including other grains on the same domain, may navigate to a
		// grain (a link) but not script it: no cross-origin subresource or fetch
		// requests, and state changes only from the grain's own pages.
		const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
		if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none" && !navigate) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("cross-origin request refused\n");
			return;
		}
		if (unsafe) {
			const ok = fetchSite !== undefined ? fetchSite === "same-origin" : req.headers.origin === undefined || req.headers.origin === grainOrigin(grain.id);
			if (!ok) {
				res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("cross-origin request refused\n");
				return;
			}
		}

		const visitor = grainVisitor(req, grain);
		if (!visitor) {
			const dest = req.headers["sec-fetch-dest"];
			if ((req.method === "GET" || req.method === "HEAD") && navigate && dest !== "iframe") {
				return redirect(res, `${shellOrigin}/g/${grain.id}/open?path=${encodeURIComponent(safePath(rawPath))}`);
			}
			if (navigate) return grainNotice(res, 401, grain, "Your session for this grain ended.");
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("sign in to this grain first\n");
			return;
		}

		// Forward. Identity comes only from Hamstr: drop anything the browser sent
		// under our header prefix, and the grain session cookie itself.
		const headers = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (HOP_BY_HOP.has(key) || key === "host" || key.startsWith("x-hamstr-") || key === "x-celld-proxy-token" || key === "x-forwarded-host") continue;
			if (key === "cookie") {
				const kept = String(value)
					.split(";")
					.map((s) => s.trim())
					.filter((s) => s && !s.startsWith(`${GRAIN_COOKIE}=`) && !s.startsWith(`${SHELL_COOKIE}=`));
				if (kept.length) headers.cookie = kept.join("; ");
				continue;
			}
			headers[key] = value;
		}
		const host = grainHost(grain.id);
		Object.assign(headers, {
			host,
			"x-forwarded-proto": config.scheme,
			"x-forwarded-host": host,
			"x-celld-proxy-token": config.proxyToken,
			"x-hamstr-grain-id": grain.id,
			"x-hamstr-session-id": visitor.gs.public_id,
			"x-hamstr-permissions": visitor.access.permissions.join(","),
			"x-hamstr-role": visitor.access.role,
			"x-hamstr-username": encodeURIComponent(visitor.user?.name ?? "Guest"),
		});
		if (visitor.user) headers["x-hamstr-user-id"] = publicUserId(visitor.user.id);

		await new Promise((done) => {
			const upstream = httpRequest(
				{ hostname: sitesApi.hostname, port: sitesApi.port || 80, path: rawPath, method: req.method, headers, timeout: 120_000 },
				(up) => {
					const out = {};
					for (const [key, value] of Object.entries(up.headers)) {
						if (HOP_BY_HOP.has(key)) continue;
						if (key === "set-cookie") {
							// A grain may set cookies for itself only: never for the parent
							// domain (other grains, other services) and never ours.
							const kept = (Array.isArray(value) ? value : [value]).filter((c) => {
								const name = c.split("=")[0].trim();
								return !/;\s*domain\s*=/i.test(c) && name !== GRAIN_COOKIE && name !== SHELL_COOKIE;
							});
							if (kept.length) out[key] = kept;
							continue;
						}
						out[key] = value;
					}
					const csp = out["content-security-policy"];
					out["content-security-policy"] = [...(csp === undefined ? [] : Array.isArray(csp) ? csp : [csp]), `frame-ancestors ${shellOrigin}`];
					out["x-robots-tag"] = "noindex";
					res.writeHead(up.statusCode ?? 502, out);
					up.pipe(res);
					up.on("end", done);
					up.on("error", () => {
						res.destroy();
						done();
					});
				},
			);
			upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
			upstream.on("error", () => {
				if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("the grain is not reachable right now\n");
				else res.destroy();
				done();
			});
			req.on("aborted", () => upstream.destroy());
			req.pipe(upstream);
		});
	}

	// --- server ---------------------------------------------------------------------------
	const server = createServer(async (req, res) => {
		const started = Date.now();
		const host = String(req.headers.host ?? "")
			.toLowerCase()
			.replace(/:\d+$/, "");
		let url;
		try {
			url = new URL(req.url || "/", "http://localhost"); // never from Host (see Cubby finding 1)
		} catch {
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request target\n");
			return;
		}
		const method = req.method ?? "GET";
		const pathname = url.pathname;
		try {
			const grain = grainPattern.exec(host);
			if (grain) await grainRequest(req, res, grain[1]);
			else if (host === config.shellHost) await shell(req, res, method, pathname, url);
			else if (pathname === "/api/health") json(res, 200, { ok: true });
			else res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("unknown host\n");
		} catch (err) {
			const status = err instanceof HttpError || err instanceof CelldError ? err.status : err instanceof ManifestError || err instanceof BundleError ? 422 : 500;
			if (status >= 500) console.error("hamstr: request failed", err);
			if (!res.headersSent) fail(res, status, status === 500 ? "internal error" : err.message);
			else res.destroy();
		} finally {
			// Paths only: query strings carry tickets.
			if (config.logging && pathname !== "/api/health") console.log(`${method} ${host}${pathname} ${res.statusCode} ${Date.now() - started}ms`);
		}
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 300_000; // installs download and check a bundle
	server.on("clientError", (_err, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});

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
		config,
		db,
		server,
		housekeeping,
		grainHost,
		listen(port = config.port, host = config.host) {
			return new Promise((resolvePromise, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolvePromise(server.address());
				});
			});
		},
		async close() {
			clearInterval(timer);
			server.closeAllConnections?.();
			await new Promise((resolvePromise) => server.close(resolvePromise));
			db.close();
		},
	};
}

const LOGO = `<img src="/favicon.svg" width="64" height="64" alt="">`;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const app = createHamstr();
	const address = await app.listen();
	const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
	console.log(`hamstr: http://${where} (shell ${app.config.shellHost}, grains ${app.config.grainPrefix}*.${app.config.grainDomain})`);
	const stop = async (signal) => {
		console.log(`hamstr: ${signal}, shutting down`);
		await app.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("unhandledRejection", (reason) => console.error("hamstr: unhandled rejection", reason));
}
