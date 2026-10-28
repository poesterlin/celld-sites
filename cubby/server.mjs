// Cubby store: a small, self-hostable catalog and blob host for celld applets.
//
// Design rules (see README.md):
//  - The store never builds or executes an applet. Publishers upload a packed
//    bundle (tools/pack.mjs output) and the store validates its shape, stores it
//    by SHA-256, and serves it back.
//  - Uploads are two steps (metadata, then bytes) so a bad manifest fails before
//    a large body is sent and the raw body stays streamable.
//  - Publishing needs a token; browsing and downloading are public. Optional
//    review mode keeps new releases out of the catalog until an admin approves.
//  - One process, one SQLite file, one blob directory: easy to back up.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BUNDLE_LIMITS, BundleError, readBundle } from "./lib/bundle.mjs";
import { ManifestError, validateManifest, validatePublisherName, validateSlug, validateVersion } from "./lib/manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
const scryptAsync = promisify(scrypt);

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"content-security-policy":
		"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const strip = (value) => String(value ?? "").replace(/\/+$/, "");
const now = () => new Date().toISOString();
const bytes = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

export function createStore(options = {}) {
	const config = {
		port: Number(options.port ?? process.env.PORT ?? 3000),
		host: options.host ?? process.env.HOST ?? "0.0.0.0",
		dataDir: resolve(options.dataDir ?? process.env.CUBBY_DATA_DIR ?? "/data"),
		adminToken: options.adminToken ?? process.env.CUBBY_ADMIN_TOKEN ?? "",
		requireReview: options.requireReview ?? process.env.CUBBY_REQUIRE_REVIEW === "1",
		rateLimit: options.rateLimit !== false,
		logging: options.logging !== false,
		maxBundle: BUNDLE_LIMITS.compressed,
		maxSource: 16 * 1024 * 1024,
		maxApps: 20,
		maxReleases: 50,
		maxPublisherBytes: 300 * 1024 * 1024,
		name: options.name ?? "Cubby",
		demo: {
			api: strip(options.demoApi ?? process.env.CUBBY_DEMO_API ?? ""),
			token: options.demoToken ?? process.env.CUBBY_DEMO_ADMIN_TOKEN ?? "",
			host: options.demoHost ?? process.env.CUBBY_DEMO_HOST ?? "demo-admin.internal",
			domain: String(options.demoDomain ?? process.env.CUBBY_DEMO_DOMAIN ?? "").replace(/^\.+/, ""),
			scheme: options.demoScheme ?? process.env.CUBBY_DEMO_SCHEME ?? "https",
			ttl: Number(options.demoTtl ?? process.env.CUBBY_DEMO_TTL_SECS ?? 900),
			max: Number(options.demoMax ?? process.env.CUBBY_DEMO_MAX ?? 8),
			perHour: Number(options.demoPerHour ?? process.env.CUBBY_DEMO_PER_HOUR ?? 6),
		},
	};
	const demoOn = Boolean(config.demo.api && config.demo.token && config.demo.domain);

	const frameSrc = demoOn ? `${config.demo.scheme}://*.${config.demo.domain}` : "'none'";
	const security = () => ({
		...SECURITY_HEADERS,
		"content-security-policy": `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-src ${frameSrc}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
	});

	const blobsDir = join(config.dataDir, "blobs");
	const tmpDir = join(config.dataDir, "tmp");
	mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
	mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
	// Uploads that died with the previous process.
	for (const name of readdirSync(tmpDir)) {
		const file = join(tmpDir, name);
		try {
			if (Date.now() - statSync(file).mtimeMs > 60 * 60 * 1000) rmSync(file, { recursive: true, force: true });
		} catch {}
	}
	const db = new DatabaseSync(join(config.dataDir, "cubby.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=NORMAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec(`
		CREATE TABLE IF NOT EXISTS publishers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			password TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tokens (
			id TEXT PRIMARY KEY,
			publisher_id INTEGER NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
			hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_used_at TEXT
		);
		CREATE TABLE IF NOT EXISTS apps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slug TEXT NOT NULL UNIQUE,
			publisher_id INTEGER NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			summary TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			homepage TEXT,
			source TEXT,
			license TEXT NOT NULL,
			icon TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS releases (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
			version TEXT NOT NULL,
			manifest TEXT NOT NULL,
			status TEXT NOT NULL,
			bundle_sha TEXT,
			bundle_size INTEGER NOT NULL DEFAULT 0,
			source_sha TEXT,
			source_size INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			published_at TEXT,
			downloads INTEGER NOT NULL DEFAULT 0,
			UNIQUE(app_id, version)
		);
		CREATE INDEX IF NOT EXISTS releases_by_app ON releases(app_id, status, published_at);
		CREATE TABLE IF NOT EXISTS reports (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL,
			resolved INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS demos (
			id TEXT PRIMARY KEY,
			app_id INTEGER NOT NULL,
			version TEXT NOT NULL,
			host TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			status TEXT NOT NULL,
			end_hash TEXT
		);
		CREATE INDEX IF NOT EXISTS demos_running ON demos(status, expires_at);
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT NOT NULL,
			note TEXT
		);
	`);

	// Older demo tables predate the end token.
	try {
		db.exec("ALTER TABLE demos ADD COLUMN end_hash TEXT");
	} catch {}

	// Abandoned publishes (metadata created, bundle never uploaded) do not hold a
	// slot forever.
	db.prepare("DELETE FROM releases WHERE status = 'uploading' AND created_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

	/** Remove finalized blobs that no release references. This catches a crash
	 *  between the atomic rename and the DB write, and older failed uploads. */
	function sweepOrphanBlobs() {
		const referenced = new Set();
		for (const row of db.prepare("SELECT bundle_sha, source_sha FROM releases").all()) {
			if (row.bundle_sha) referenced.add(`bundle:${row.bundle_sha}`);
			if (row.source_sha) referenced.add(`source:${row.source_sha}`);
		}
		for (const name of readdirSync(blobsDir)) {
			const match = /^(source-)?([a-f0-9]{64})\.tgz$/.exec(name);
			if (!match) continue;
			const kind = match[1] ? "source" : "bundle";
			if (!referenced.has(`${kind}:${match[2]}`)) rmSync(join(blobsDir, name), { force: true });
		}
	}
	sweepOrphanBlobs();

	const q = {
		publisherByName: db.prepare("SELECT * FROM publishers WHERE name = ?"),
		publisherById: db.prepare("SELECT id, name, created_at FROM publishers WHERE id = ?"),
		appBySlug: db.prepare("SELECT * FROM apps WHERE slug = ?"),
		releaseById: db.prepare("SELECT r.*, a.slug, a.publisher_id, a.name AS app_name FROM releases r JOIN apps a ON a.id = r.app_id WHERE r.id = ?"),
		releaseByVersion: db.prepare(
			"SELECT r.* FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.slug = ? AND r.version = ?",
		),
	};

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

	// --- passwords and tokens -------------------------------------------------
	async function hashPassword(password) {
		const salt = randomBytes(16);
		const key = await scryptAsync(password, salt, 32);
		return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
	}
	async function checkPassword(password, stored) {
		const [alg, saltHex, keyHex] = String(stored).split("$");
		if (alg !== "scrypt" || !saltHex || !keyHex) return false;
		const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 32);
		const want = Buffer.from(keyHex, "hex");
		return key.length === want.length && timingSafeEqual(key, want);
	}
	function issueToken(publisherId) {
		const id = randomBytes(6).toString("hex");
		const secret = randomBytes(32).toString("base64url");
		db.prepare("INSERT INTO tokens (id, publisher_id, hash, created_at) VALUES (?, ?, ?, ?)").run(id, publisherId, sha256(secret), now());
		return `cub_${id}_${secret}`;
	}
	function authenticate(req) {
		const header = req.headers.authorization ?? "";
		const match = /^Bearer cub_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/.exec(header);
		if (!match) return null;
		const row = db.prepare("SELECT t.*, p.name AS publisher FROM tokens t JOIN publishers p ON p.id = t.publisher_id WHERE t.id = ?").get(match[1]);
		if (!row) return null;
		const got = Buffer.from(sha256(match[2]), "hex");
		const want = Buffer.from(row.hash, "hex");
		if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
		db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
		return { id: row.publisher_id, name: row.publisher, tokenId: row.id };
	}
	function adminOk(req) {
		if (!config.adminToken) return false;
		const got = String(req.headers["x-admin-token"] ?? "");
		if (!got) return false;
		const a = Buffer.from(got);
		const b = Buffer.from(config.adminToken);
		return a.length === b.length && timingSafeEqual(a, b);
	}
	function requireAdmin(req, res) {
		if (!config.adminToken) {
			json(res, 503, { error: "admin endpoints are disabled (set CUBBY_ADMIN_TOKEN)" });
			return false;
		}
		if (!adminOk(req)) {
			json(res, 401, { error: "admin token required" });
			return false;
		}
		return true;
	}

	// --- rate limits (in memory; a restart resets them) -----------------------
	const buckets = new Map();
	function rateLimited(key, max, windowMs) {
		if (!config.rateLimit) return false;
		const at = Date.now();
		const bucket = buckets.get(key);
		if (!bucket || bucket.reset <= at) {
			buckets.set(key, { count: 1, reset: at + windowMs });
			return false;
		}
		bucket.count++;
		return bucket.count > max;
	}
	const clientIp = (req) => {
		const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		return forwarded[forwarded.length - 1] || req.socket.remoteAddress || "?";
	};
	const tooMany = (res) => json(res, 429, { error: "too many requests, slow down" }, { "retry-after": "60" });

	// --- helpers --------------------------------------------------------------
	function json(res, status, body, extra = {}) {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			...security(),
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store",
			...extra,
		});
		res.end(payload);
	}
	const fail = (res, status, message) => json(res, status, { error: message });

	async function readJson(req, limit = 1024 * 1024) {
		const length = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(length) && length > limit) throw new HttpError(413, "request body is too large");
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit) throw new HttpError(413, "request body is too large");
			chunks.push(chunk);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		} catch {
			throw new HttpError(400, "body is not valid JSON");
		}
	}

	/** Stream a raw request body to `dest`, hashing it. Requires Content-Length:
	 *  it is the cheapest way to reject an oversized upload before reading it. */
	async function receive(req, dest, limit) {
		const raw = req.headers["content-length"];
		if (raw === undefined) throw new HttpError(411, "Content-Length is required");
		const size = Number(raw);
		if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(411, "Content-Length must be a positive number");
		if (size > limit) throw new HttpError(413, `body is larger than ${bytes(limit)}`);
		const hash = createHash("sha256");
		let got = 0;
		await new Promise((resolvePromise, rejectPromise) => {
			const out = createWriteStream(dest, { flags: "wx", mode: 0o600 });
			const done = (err) => {
				out.destroy();
				req.unpipe(out);
				if (err) {
					rmSync(dest, { force: true });
					rejectPromise(err);
				} else resolvePromise();
			};
			req.on("data", (chunk) => {
				got += chunk.length;
				hash.update(chunk);
				if (got > limit) done(new HttpError(413, `body is larger than ${bytes(limit)}`));
			});
			req.on("aborted", () => done(new HttpError(400, "upload aborted")));
			req.on("error", done);
			out.on("error", done);
			out.on("finish", () => done());
			req.pipe(out);
		});
		if (got !== size) throw new HttpError(400, "upload ended before its Content-Length");
		return { sha: hash.digest("hex"), size: got };
	}

	const manifestOf = (row) => JSON.parse(row.manifest);
	const tagsOf = (app) => {
		try {
			return JSON.parse(app.tags);
		} catch {
			return [];
		}
	};

	function releaseView(row, { owner = false, includeManifest = false } = {}) {
		const view = {
			version: row.version,
			status: row.status,
			createdAt: row.created_at,
			publishedAt: row.published_at,
			downloads: row.downloads,
			bundleSha256: row.bundle_sha,
			bundleSize: row.bundle_size,
			sourceSha256: row.source_sha,
			sourceSize: row.source_size,
			...(owner && { id: row.id }),
			...(includeManifest && { manifest: manifestOf(row) }),
		};
		return view;
	}

	function cardView(app) {
		return {
			slug: app.slug,
			name: app.name,
			summary: app.summary,
			icon: app.icon,
			license: app.license,
			tags: tagsOf(app),
			publisher: app.publisher,
			version: app.version,
			releaseCount: app.release_count,
			downloads: app.downloads,
			updatedAt: app.updated_at,
		};
	}

	function appStorage(publisherId) {
		return db
			.prepare("SELECT COALESCE(SUM(r.bundle_size + r.source_size), 0) AS total FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = ?")
			.get(publisherId).total;
	}

	function logEvent(actor, action, target, note = null) {
		db.prepare("INSERT INTO events (at, actor, action, target, note) VALUES (?, ?, ?, ?, ?)").run(now(), actor, action, target, note);
	}

	function deleteBlobIfUnused(sha, kind = "bundle") {
		if (!sha) return;
		const column = kind === "source" ? "source_sha" : "bundle_sha";
		const used = db.prepare(`SELECT 1 FROM releases WHERE ${column} = ? LIMIT 1`).get(sha);
		if (used) return;
		rmSync(join(blobsDir, `${kind === "source" ? "source-" : ""}${sha}.tgz`), { force: true });
	}

	// --- demo sessions --------------------------------------------------------
	// A demo is a real deploy to a separate celld node, on a random host, with no
	// egress and a short lifetime. The store never gets the production admin
	// token; config.demo.token only reaches the demo node.
	function demoRequest(method, pathname, body, contentType = "application/json") {
		const base = new URL(config.demo.api);
		return new Promise((resolvePromise, rejectPromise) => {
			const headers = { Host: config.demo.host, authorization: `Bearer ${config.demo.token}` };
			if (body !== undefined) {
				headers["content-type"] = contentType;
				headers["content-length"] = Buffer.byteLength(body);
			}
			const req = httpRequest(
				{ hostname: base.hostname, port: base.port || 80, path: `/__admin${pathname}`, method, headers, timeout: 90_000 },
				(res) => {
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
				},
			);
			req.on("timeout", () => req.destroy(new Error("demo node timed out")));
			req.on("error", rejectPromise);
			if (body !== undefined) req.write(body);
			req.end();
		});
	}
	async function demoJson(method, pathname, body) {
		const result = await demoRequest(method, pathname, body === undefined ? undefined : JSON.stringify(body));
		let parsed = {};
		try {
			parsed = JSON.parse(result.body);
		} catch {}
		if (result.status >= 300) throw new HttpError(502, parsed.error || `demo node answered ${result.status}`);
		return parsed;
	}
	async function deleteDemoSite(host) {
		try {
			const result = await demoRequest("DELETE", `/site?id=${encodeURIComponent(host)}&confirm=${encodeURIComponent(host)}`);
			return result.status < 300 || result.status === 404;
		} catch {
			return false;
		}
	}
	async function deployDemo(bundlePath, host) {
		// Use the data volume, not /tmp: the container tmpfs is small and demo
		// extraction is bounded only by BUNDLE_LIMITS.uncompressed (80 MiB).
		const tmp = mkdtempSync(join(tmpDir, "demo-"));
		try {
			const meta = await readBundle(bundlePath, { extractTo: tmp });
			const code = readFileSync(join(tmp, "code.json"));
			const hashes = [...new Set(Object.values(meta.code.files).map((value) => value[0]))];
			const missing = await demoJson("POST", "/blobs/missing", hashes);
			if (!Array.isArray(missing.missing)) throw new Error("demo node did not list missing blobs");
			for (let i = 0; i < missing.missing.length; i += 6) {
				await Promise.all(
					missing.missing.slice(i, i + 6).map((hash) =>
						demoRequest("PUT", `/blob?hash=${hash}`, readFileSync(join(tmp, "blobs", hash)), "application/octet-stream").then((r) => {
							if (r.status >= 300) throw new Error(`uploading a demo blob failed (${r.status})`);
						}),
					),
				);
			}
			const staged = await demoRequest("PUT", `/code?version=${encodeURIComponent(meta.version)}&host=${encodeURIComponent(host)}`, code);
			if (staged.status >= 300) throw new HttpError(502, `staging the demo code failed (${staged.status}): ${staged.body.slice(0, 300)}`);
			const check = await demoJson("POST", `/check?host=${encodeURIComponent(host)}&version=${encodeURIComponent(meta.version)}`);
			if (!check.ok) throw new HttpError(422, `the demo failed its deploy check: ${check.error ?? check.status}`);
			await demoJson("POST", `/activate?host=${encodeURIComponent(host)}&version=${encodeURIComponent(meta.version)}`);
			return { version: meta.version };
		} catch (err) {
			await deleteDemoSite(host);
			if (err?.code === "ENOSPC") throw new HttpError(413, "the demo store has no room for this bundle");
			throw err;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	function newDemo() {
		const id = randomBytes(6).toString("hex");
		return { id, host: `demo-${id}.${config.demo.domain}` };
	}
	async function cleanupDemos() {
		if (!demoOn) return;
		const due = db.prepare("SELECT * FROM demos WHERE status IN ('starting', 'running') AND expires_at <= ?").all(now());
		for (const row of due) {
			if (!(await deleteDemoSite(row.host))) continue;
			db.prepare("UPDATE demos SET status = 'expired' WHERE id = ?").run(row.id);
		}
		db.prepare("DELETE FROM demos WHERE status = 'expired' AND created_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
		// The demo bucket is disposable; keep its code blobs from accumulating.
		if (Date.now() - lastDemoPrune > 10 * 60 * 1000) {
			lastDemoPrune = Date.now();
			await demoRequest("POST", "/prune?confirm=prune&keep=0&orphanAge=300").catch(() => {});
		}
	}
	let lastDemoPrune = 0;
	let demoTimer = null;
	if (demoOn) {
		setTimeout(() => cleanupDemos().catch((err) => console.error("cubby: demo cleanup failed", err)), 5000).unref();
		demoTimer = setInterval(() => cleanupDemos().catch((err) => console.error("cubby: demo cleanup failed", err)), 60_000);
		demoTimer.unref();
	}

	// --- static UI ------------------------------------------------------------
	function serveStatic(req, res, pathname) {
		const map = {
			"/": "index.html",
			"/index.html": "index.html",
			"/app.js": "app.js",
			"/style.css": "style.css",
			"/favicon.svg": "favicon.svg",
			"/fonts/fraunces-latin-wght-normal.woff2": "fonts/fraunces-latin-wght-normal.woff2",
			"/fonts/ibm-plex-mono-latin-400-normal.woff2": "fonts/ibm-plex-mono-latin-400-normal.woff2",
			"/fonts/ibm-plex-mono-latin-500-normal.woff2": "fonts/ibm-plex-mono-latin-500-normal.woff2",
			"/fonts/LICENSE.txt": "fonts/LICENSE.txt",
		};
		const name = map[pathname];
		if (!name) return false;
		const file = resolve(join(PUBLIC_DIR, name));
		if (!file.startsWith(PUBLIC_DIR + sep)) return false;
		if (!existsSync(file)) return false;
		const body = readFileSync(file);
		res.writeHead(200, {
			...security(),
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"content-length": body.length,
			"cache-control": name === "index.html" ? "no-cache" : "public, max-age=300",
		});
		res.end(req.method === "HEAD" ? undefined : body);
		return true;
	}

	// --- HTTP -----------------------------------------------------------------
	const server = createServer(async (req, res) => {
		const started = Date.now();
		// Never build this from the Host header: a client-controlled value such as
		// `Host: cubby.localhost:abc` throws from the URL parser. The router only
		// needs the path/query, so use a fixed base and reject a malformed target.
		let url;
		try {
			url = new URL(req.url || "/", "http://localhost");
		} catch {
			fail(res, 400, "bad request target");
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = req.method ?? "GET";
		try {
			if (pathname.startsWith("/api/")) {
				await api(req, res, method, pathname, url);
			} else if (method === "GET" || method === "HEAD") {
				if (!serveStatic(req, res, pathname)) res.writeHead(404, { ...security(), "content-type": "text/plain; charset=utf-8" }).end("not found\n");
			} else {
				fail(res, 405, "method not allowed");
			}
		} catch (err) {
			const status = err instanceof HttpError ? err.status : err instanceof ManifestError || err instanceof BundleError ? 422 : 500;
			if (status === 500) console.error("cubby: request failed", err);
			if (!res.headersSent) fail(res, status, status === 500 ? "internal error" : err.message);
			else res.destroy();
		} finally {
			const ms = Date.now() - started;
			if (config.logging && !pathname.startsWith("/api/health")) console.log(`${method} ${pathname} ${res.statusCode} ${ms}ms`);
		}
	});
	// Slowloris and stalled uploads are bounded at the socket level too.
	server.requestTimeout = 120_000;
	server.headersTimeout = 15_000;
	server.on("clientError", (_err, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});

	async function api(req, res, method, pathname, url) {
		// Public reads and account endpoints.
		if (method === "GET" && pathname === "/api/health") {
			const apps = db.prepare("SELECT count(*) AS n FROM apps").get().n;
			const releases = db.prepare("SELECT count(*) AS n FROM releases WHERE status = 'published'").get().n;
			return json(res, 200, { ok: true, name: config.name, apps, releases, review: config.requireReview });
		}

		if (pathname === "/api/v1/publishers" && method === "POST") {
			if (rateLimited(`register:${clientIp(req)}`, 5, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 16 * 1024);
			const name = validatePublisherName(String(body.name ?? ""));
			const password = String(body.password ?? "");
			if (password.length < 10 || password.length > 200) throw new HttpError(400, "password must be 10-200 characters");
			if (q.publisherByName.get(name)) throw new HttpError(409, "that publisher name is taken");
			const hash = await hashPassword(password);
			const info = db.prepare("INSERT INTO publishers (name, password, created_at) VALUES (?, ?, ?)").run(name, hash, now());
			const token = issueToken(info.lastInsertRowid);
			logEvent(name, "register", name);
			return json(res, 201, { publisher: { name }, token });
		}

		if (pathname === "/api/v1/tokens" && method === "POST") {
			if (rateLimited(`login:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 16 * 1024);
			const name = String(body.name ?? "");
			const password = String(body.password ?? "");
			const publisher = q.publisherByName.get(name);
			if (!publisher || !(await checkPassword(password, publisher.password))) throw new HttpError(401, "wrong name or password");
			const token = issueToken(publisher.id);
			return json(res, 201, { token });
		}

		const me = authenticate(req);
		if (pathname === "/api/v1/me") {
			if (!me) return fail(res, 401, "sign in with a token first");
			const apps = db.prepare("SELECT * FROM apps WHERE publisher_id = ? ORDER BY updated_at DESC").all(me.id);
			return json(res, 200, {
				publisher: { name: me.name },
				storageUsed: appStorage(me.id),
				apps: apps.map((app) => ({
					...cardView({ ...app, publisher: me.name, version: null, release_count: 0, downloads: 0 }),
					releases: db
						.prepare("SELECT * FROM releases WHERE app_id = ? ORDER BY created_at DESC")
						.all(app.id)
						.map((r) => releaseView(r, { owner: true, includeManifest: true })),
				})),
			});
		}
		if (pathname === "/api/v1/tokens" && method === "DELETE") {
			if (!me) return fail(res, 401, "sign in with a token first");
			db.prepare("DELETE FROM tokens WHERE publisher_id = ?").run(me.id);
			return json(res, 200, { ok: true });
		}

		// Catalog.
		if (pathname === "/api/v1/apps" && method === "GET") {
			const search = String(url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
			const tag = String(url.searchParams.get("tag") ?? "").trim().toLowerCase().slice(0, 20);
			const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
			const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
			const where = `EXISTS (SELECT 1 FROM releases r WHERE r.app_id = a.id AND r.status = 'published')
				AND (? = '' OR instr(lower(a.name || ' ' || a.summary || ' ' || a.description), ?) > 0)
				AND (? = '' OR instr(a.tags, ?) > 0)`;
			const rows = db
				.prepare(
					`SELECT a.*, p.name AS publisher,
						(SELECT version FROM releases r WHERE r.app_id = a.id AND r.status = 'published' ORDER BY r.published_at DESC LIMIT 1) AS version,
						(SELECT COUNT(*) FROM releases r WHERE r.app_id = a.id AND r.status = 'published') AS release_count,
						(SELECT COALESCE(SUM(r.downloads), 0) FROM releases r WHERE r.app_id = a.id AND r.status = 'published') AS downloads
					 FROM apps a JOIN publishers p ON p.id = a.publisher_id
					 WHERE ${where}
					 ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`,
				)
				.all(search, search, tag, tag ? `"${tag}"` : "", limit, offset);
			const total = db.prepare(`SELECT COUNT(*) AS n FROM apps a WHERE ${where}`).get(search, search, tag, tag ? `"${tag}"` : "").n;
			return json(res, 200, { apps: rows.map(cardView), total, limit, offset });
		}

		const appMatch = /^\/api\/v1\/apps\/([a-z0-9-]+)$/.exec(pathname);
		if (appMatch && method === "GET") {
			const app = q.appBySlug.get(appMatch[1]);
			if (!app) return fail(res, 404, "no such app");
			const owner = me && me.id === app.publisher_id;
			const releases = db
				.prepare("SELECT * FROM releases WHERE app_id = ? ORDER BY created_at DESC")
				.all(app.id)
				.filter((r) => owner || r.status === "published");
			if (!owner && releases.length === 0) return fail(res, 404, "no such app");
			const publisher = db.prepare("SELECT name FROM publishers WHERE id = ?").get(app.publisher_id);
			const latest = releases.find((r) => r.status === "published") ?? releases[0];
			return json(res, 200, {
				app: {
					...cardView({
						...app,
						publisher: publisher.name,
						version: latest?.version ?? null,
						release_count: releases.filter((r) => r.status === "published").length,
						downloads: releases.reduce((n, r) => n + (r.status === "published" ? r.downloads : 0), 0),
					}),
					description: app.description,
					homepage: app.homepage,
					source: app.source,
					createdAt: app.created_at,
				},
				releases: releases.map((r) => releaseView(r, { owner, includeManifest: true })),
				demo: (() => {
					const published = releases.find((r) => r.status === "published");
					const manifest = published ? manifestOf(published) : null;
					const reason = !demoOn
						? "demos are not enabled on this store"
						: !published
							? "no published release"
							: (manifest?.egress?.length ?? 0) > 0
								? "this app needs network access; install it to try it"
								: null;
					return { enabled: demoOn, available: !reason, reason };
				})(),
				...(owner && { owner: true }),
			});
		}

		// Download (public).
		const downloadMatch = /^\/api\/v1\/apps\/([a-z0-9-]+)\/releases\/([^/]+)\/(download|source)$/.exec(pathname);
		if (downloadMatch && (method === "GET" || method === "HEAD")) {
			if (rateLimited(`download:${clientIp(req)}`, 600, 60 * 1000)) return tooMany(res);
			const [, slug, rawVersion, kind] = downloadMatch;
			if (!validateVersion(rawVersion)) return fail(res, 400, "bad version");
			const row = q.releaseByVersion.get(slug, rawVersion);
			if (!row) return fail(res, 404, "no such release");
			if (row.status === "yanked") return fail(res, 410, "this release was withdrawn");
			if (row.status === "pending" || row.status === "uploading") return fail(res, 404, "no such release");
			if (row.status === "removed") return fail(res, 404, "no such release");
			const sha = kind === "download" ? row.bundle_sha : row.source_sha;
			if (!sha) return fail(res, 404, kind === "download" ? "this release has no bundle" : "this release has no source archive");
			const file = join(blobsDir, `${kind === "source" ? "source-" : ""}${sha}.tgz`);
			if (!existsSync(file)) return fail(res, 500, "stored bundle is missing");
			if (kind === "download") db.prepare("UPDATE releases SET downloads = downloads + 1 WHERE id = ?").run(row.id);
			const size = statSync(file).size;
			res.writeHead(200, {
				...security(),
				"content-type": "application/gzip",
				"content-length": size,
				"x-cubby-sha256": sha,
				"content-disposition": `attachment; filename="${slug}-${rawVersion}.${kind === "download" ? "tgz" : "source.tgz"}"`,
				"cache-control": "public, max-age=31536000, immutable",
			});
			if (method === "HEAD") return res.end();
			return createReadStream(file).pipe(res);
		}

		// Interactive demo sessions: a throwaway site on the demo node.
		const demoStart = /^\/api\/v1\/apps\/([a-z0-9-]+)\/demo$/.exec(pathname);
		if (demoStart && method === "POST") {
			if (!demoOn) return fail(res, 503, "interactive demos are not enabled on this store");
			if (rateLimited(`demo:${clientIp(req)}`, config.demo.perHour, 60 * 60 * 1000)) return tooMany(res);
			const slug = validateSlug(demoStart[1]);
			const app = q.appBySlug.get(slug);
			if (!app) return fail(res, 404, "no such app");
			const release = db
				.prepare("SELECT * FROM releases WHERE app_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1")
				.get(app.id);
			if (!release) return fail(res, 404, "no published release");
			const manifest = JSON.parse(release.manifest);
			if ((manifest.egress ?? []).length) return fail(res, 409, "this app needs network access; install it to try it");
			const owner = me && me.id === app.publisher_id;
			if (!owner && !release.bundle_sha) return fail(res, 409, "this release has no bundle");
			const busy = db.prepare("SELECT count(*) AS n FROM demos WHERE status IN ('starting', 'running') AND expires_at > ?").get(now()).n;
			if (busy >= config.demo.max) return fail(res, 503, "all demo slots are busy; try again in a minute");
			const { id, host } = newDemo();
			const endToken = randomBytes(24).toString("base64url");
			const endHash = sha256(endToken);
			const ttl = Math.max(60, Math.min(3600, config.demo.ttl));
			const expires = new Date(Date.now() + ttl * 1000).toISOString();
			db.prepare("INSERT INTO demos (id, app_id, version, host, created_at, expires_at, status, end_hash) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?)").run(
				id,
				app.id,
				release.version,
				host,
				now(),
				expires,
				endHash,
			);
			try {
				const file = join(blobsDir, `${release.bundle_sha}.tgz`);
				if (!existsSync(file)) throw new HttpError(500, "stored bundle is missing");
				await deployDemo(file, host);
				db.prepare("UPDATE demos SET status = 'running' WHERE id = ?").run(id);
				return json(res, 201, {
					id,
					url: `${config.demo.scheme}://${host}`,
					host,
					expiresAt: expires,
					app: { slug: app.slug, name: app.name },
					version: release.version,
					endToken,
				});
			} catch (err) {
				await deleteDemoSite(host);
				db.prepare("DELETE FROM demos WHERE id = ?").run(id);
				return fail(res, err.status ?? 422, err.message);
			}
		}
		const demoView = /^\/api\/v1\/demos\/([a-f0-9]{12})$/.exec(pathname);
		if (demoView) {
			const row = db
				.prepare("SELECT d.*, a.slug AS app_slug, a.name AS app_name FROM demos d LEFT JOIN apps a ON a.id = d.app_id WHERE d.id = ?")
				.get(demoView[1]);
			if (!row) return fail(res, 404, "no such demo");
			if (method === "GET") {
				return json(res, 200, {
					id: row.id,
					url: `${config.demo.scheme}://${row.host}`,
					host: row.host,
					version: row.version,
					expiresAt: row.expires_at,
					status: row.status,
					app: row.app_slug ? { slug: row.app_slug, name: row.app_name } : null,
				});
			}
			if (method === "DELETE") {
				if (row.end_hash) {
					const supplied = String(req.headers["x-demo-token"] ?? "");
					const got = Buffer.from(sha256(supplied), "hex");
					const want = Buffer.from(row.end_hash, "hex");
					if (got.length !== want.length || !timingSafeEqual(got, want)) {
						return fail(res, 403, "the demo's end token is required");
					}
				}
				if (row.status === "running" || row.status === "starting") {
					const ok = await deleteDemoSite(row.host);
					if (!ok) return fail(res, 502, "could not stop the demo; it will expire on its own");
					db.prepare("UPDATE demos SET status = 'expired' WHERE id = ?").run(row.id);
				}
				return json(res, 200, { ok: true });
			}
		}

		// Publishing.
		const newRelease = /^\/api\/v1\/apps\/([a-z0-9-]+)\/releases$/.exec(pathname);
		if (newRelease && method === "POST") {
			if (!me) return fail(res, 401, "a publisher token is required");
			if (rateLimited(`publish:${me.id}`, 30, 60 * 60 * 1000)) return tooMany(res);
			const slug = validateSlug(newRelease[1]);
			const body = await readJson(req, 64 * 1024);
			const manifest = validateManifest(body.manifest);
			if (manifest.slug !== slug) return fail(res, 422, `manifest slug ${manifest.slug} does not match ${slug}`);
			const app = q.appBySlug.get(slug);
			if (app && app.publisher_id !== me.id) return fail(res, 403, "that app id belongs to another publisher");
			if (app && db.prepare("SELECT 1 FROM releases WHERE app_id = ? AND version = ?").get(app.id, manifest.version)) {
				return fail(res, 409, `${slug}@${manifest.version} already exists`);
			}
			if (!app) {
				const count = db.prepare("SELECT COUNT(*) AS n FROM apps WHERE publisher_id = ?").get(me.id).n;
				if (count >= config.maxApps) return fail(res, 403, `a publisher may have at most ${config.maxApps} apps`);
			}
			const releases = app ? db.prepare("SELECT COUNT(*) AS n FROM releases WHERE app_id = ?").get(app.id).n : 0;
			if (releases >= config.maxReleases) return fail(res, 403, `an app may have at most ${config.maxReleases} releases`);
			const release = tx(() => {
				let appId = app?.id;
				if (!appId) {
					const info = db
						.prepare(
							"INSERT INTO apps (slug, publisher_id, name, summary, description, homepage, source, license, icon, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
						)
						.run(slug, me.id, manifest.name, manifest.summary, manifest.description, manifest.homepage ?? null, manifest.source ?? null, manifest.license, manifest.icon, JSON.stringify(manifest.tags), now(), now());
					appId = info.lastInsertRowid;
				}
				const info = db
					.prepare("INSERT INTO releases (app_id, version, manifest, status, created_at) VALUES (?, ?, ?, 'uploading', ?)")
					.run(appId, manifest.version, JSON.stringify(manifest), now());
				return { id: info.lastInsertRowid, appId };
			});
			logEvent(me.name, "release.create", `${slug}@${manifest.version}`);
			return json(res, 201, {
				release: { id: release.id, version: manifest.version, status: "uploading" },
				upload: { method: "PUT", url: `/api/v1/releases/${release.id}/bundle`, maxBytes: config.maxBundle },
			});
		}

		const uploadMatch = /^\/api\/v1\/releases\/(\d+)\/(bundle|source)$/.exec(pathname);
		if (uploadMatch && method === "PUT") {
			if (!me) return fail(res, 401, "a publisher token is required");
			if (rateLimited(`upload:${me.id}`, 120, 60 * 60 * 1000)) return tooMany(res);
			const row = q.releaseById.get(Number(uploadMatch[1]));
			if (!row) return fail(res, 404, "no such release");
			if (row.publisher_id !== me.id) return fail(res, 403, "not your release");
			if (row.status === "yanked") return fail(res, 409, "this release was yanked");
			const kind = uploadMatch[2];
			if (kind === "source" && row.source_sha) return fail(res, 409, "this release already has a source archive");
			const limit = kind === "bundle" ? config.maxBundle : config.maxSource;
			const tmp = join(tmpDir, `${row.id}-${randomBytes(8).toString("hex")}.tgz`);
			const received = await receive(req, tmp, limit);
			const expected = String(req.headers["x-content-sha256"] ?? "").toLowerCase();
			if (expected && expected !== received.sha) {
				rmSync(tmp, { force: true });
				return fail(res, 422, "the upload does not match X-Content-Sha256");
			}

			if (kind === "bundle") {
				if (row.bundle_sha) {
					rmSync(tmp, { force: true });
					return fail(res, 409, "this release already has a bundle");
				}
				let meta;
				try {
					meta = await readBundle(tmp);
				} catch (err) {
					rmSync(tmp, { force: true });
					if (err instanceof BundleError) return fail(res, 422, `invalid bundle: ${err.message}`);
					throw err;
				}
				const used = appStorage(me.id);
				if (used + received.size > config.maxPublisherBytes) {
					rmSync(tmp, { force: true });
					return fail(res, 413, `publisher storage limit is ${bytes(config.maxPublisherBytes)}`);
				}
				const blob = join(blobsDir, `${received.sha}.tgz`);
				renameSync(tmp, blob); // same filesystem: atomic
				const status = config.requireReview ? "pending" : "published";
				const manifest = JSON.parse(row.manifest);
				const won = tx(() => {
					// Compare-and-set: two uploads can both pass the read above, but
					// only one may become the bundle of this release. The loser's
					// blob is removed instead of leaking outside the quota.
					const changed = db
						.prepare("UPDATE releases SET bundle_sha = ?, bundle_size = ?, status = ?, published_at = ? WHERE id = ? AND bundle_sha IS NULL")
						.run(received.sha, received.size, status, status === "published" ? now() : null, row.id);
					if (!changed.changes) return false;
					db.prepare(
						"UPDATE apps SET name = ?, summary = ?, description = ?, homepage = ?, source = ?, license = ?, icon = ?, tags = ?, updated_at = ? WHERE id = ?",
					).run(
						manifest.name,
						manifest.summary,
						manifest.description,
						manifest.homepage ?? null,
						manifest.source ?? null,
						manifest.license,
						manifest.icon,
						JSON.stringify(manifest.tags),
						now(),
						row.app_id,
					);
					return true;
				});
				if (!won) {
					deleteBlobIfUnused(received.sha);
					return fail(res, 409, "another upload already completed this release");
				}
				logEvent(me.name, status === "published" ? "release.publish" : "release.submit", `${row.slug}@${row.version}`, `sha256:${received.sha}`);
				return json(res, 201, { release: { id: row.id, version: row.version, status, bundleSha256: received.sha, bundleSize: received.size } });
			}

			if (appStorage(me.id) + received.size > config.maxPublisherBytes) {
				rmSync(tmp, { force: true });
				return fail(res, 413, `publisher storage limit is ${bytes(config.maxPublisherBytes)}`);
			}
			const blob = join(blobsDir, `source-${received.sha}.tgz`);
			if (!existsSync(blob)) renameSync(tmp, blob);
			else rmSync(tmp, { force: true });
			const changed = db
				.prepare("UPDATE releases SET source_sha = ?, source_size = ? WHERE id = ? AND source_sha IS NULL")
				.run(received.sha, received.size, row.id);
			if (!changed.changes) {
				deleteBlobIfUnused(received.sha, "source");
				return fail(res, 409, "another source archive already completed this release");
			}
			return json(res, 201, { release: { id: row.id, version: row.version, sourceSha256: received.sha, sourceSize: received.size } });
		}

		// Owner operations: yank, delete release, delete app.
		const releaseOp = /^\/api\/v1\/releases\/(\d+)(?:\/(yank))?$/.exec(pathname);
		if (releaseOp) {
			if (!me) return fail(res, 401, "a publisher token is required");
			const row = q.releaseById.get(Number(releaseOp[1]));
			if (!row) return fail(res, 404, "no such release");
			if (row.publisher_id !== me.id) return fail(res, 403, "not your release");
			if (releaseOp[2] === "yank" && method === "POST") {
				db.prepare("UPDATE releases SET status = 'yanked' WHERE id = ?").run(row.id);
				logEvent(me.name, "release.yank", `${row.slug}@${row.version}`);
				return json(res, 200, { ok: true });
			}
			if (!releaseOp[2] && method === "DELETE") {
				db.prepare("DELETE FROM releases WHERE id = ?").run(row.id);
				deleteBlobIfUnused(row.bundle_sha);
				deleteBlobIfUnused(row.source_sha, "source");
				logEvent(me.name, "release.delete", `${row.slug}@${row.version}`);
				return json(res, 200, { ok: true });
			}
		}

		const appDelete = /^\/api\/v1\/apps\/([a-z0-9-]+)$/.exec(pathname);
		if (appDelete && method === "DELETE") {
			if (!me) return fail(res, 401, "a publisher token is required");
			const app = q.appBySlug.get(appDelete[1]);
			if (!app) return fail(res, 404, "no such app");
			if (app.publisher_id !== me.id) return fail(res, 403, "not your app");
			const shas = db.prepare("SELECT bundle_sha, source_sha FROM releases WHERE app_id = ?").all(app.id);
			db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
			shas.forEach((r) => {
				deleteBlobIfUnused(r.bundle_sha);
				deleteBlobIfUnused(r.source_sha, "source");
			});
			logEvent(me.name, "app.delete", app.slug);
			return json(res, 200, { ok: true });
		}

		// Abuse reports: no account needed, rate-limited by IP.
		const reportMatch = /^\/api\/v1\/apps\/([a-z0-9-]+)\/releases\/([^/]+)\/report$/.exec(pathname);
		if (reportMatch && method === "POST") {
			if (rateLimited(`report:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 8 * 1024);
			const reason = String(body.reason ?? "").trim();
			if (reason.length < 5 || reason.length > 1000) throw new HttpError(400, "reason must be 5-1000 characters");
			if (!validateVersion(reportMatch[2])) return fail(res, 400, "bad version");
			const row = q.releaseByVersion.get(reportMatch[1], reportMatch[2]);
			if (!row) return fail(res, 404, "no such release");
			db.prepare("INSERT INTO reports (release_id, reason, created_at) VALUES (?, ?, ?)").run(row.id, reason, now());
			return json(res, 202, { ok: true });
		}

		// Admin.
		if (pathname.startsWith("/api/v1/admin/")) {
			if (!requireAdmin(req, res)) return;
			if (pathname === "/api/v1/admin/pending" && method === "GET") {
				const rows = db
					.prepare("SELECT r.*, a.slug, a.name AS app_name FROM releases r JOIN apps a ON a.id = r.app_id WHERE r.status = 'pending' ORDER BY r.created_at")
					.all();
				return json(res, 200, { releases: rows.map((r) => ({ ...releaseView(r, { owner: true, includeManifest: true }), slug: r.slug, name: r.app_name })) });
			}
			if (pathname === "/api/v1/admin/reports" && method === "GET") {
				const rows = db
					.prepare(
						"SELECT rep.*, r.version, a.slug, a.name AS app_name FROM reports rep JOIN releases r ON r.id = rep.release_id JOIN apps a ON a.id = r.app_id WHERE rep.resolved = 0 ORDER BY rep.created_at",
					)
					.all();
				return json(res, 200, { reports: rows });
			}
			const resolveReport = /^\/api\/v1\/admin\/reports\/(\d+)\/resolve$/.exec(pathname);
			if (resolveReport && method === "POST") {
				db.prepare("UPDATE reports SET resolved = 1 WHERE id = ?").run(Number(resolveReport[1]));
				return json(res, 200, { ok: true });
			}
			const approve = /^\/api\/v1\/admin\/releases\/(\d+)\/approve$/.exec(pathname);
			if (approve && method === "POST") {
				const row = q.releaseById.get(Number(approve[1]));
				if (!row) return fail(res, 404, "no such release");
				if (!row.bundle_sha) return fail(res, 409, "that release has no uploaded bundle");
				const manifest = JSON.parse(row.manifest);
				tx(() => {
					db.prepare("UPDATE releases SET status = 'published', published_at = ? WHERE id = ?").run(now(), row.id);
					db.prepare("UPDATE apps SET updated_at = ? WHERE id = ?").run(now(), row.app_id);
				});
				logEvent("admin", "release.approve", `${row.slug}@${row.version}`, manifest.name);
				return json(res, 200, { ok: true });
			}
			const remove = /^\/api\/v1\/admin\/releases\/(\d+)$/.exec(pathname);
			if (remove && method === "DELETE") {
				const row = q.releaseById.get(Number(remove[1]));
				if (!row) return fail(res, 404, "no such release");
				db.prepare("DELETE FROM releases WHERE id = ?").run(row.id);
				deleteBlobIfUnused(row.bundle_sha);
				deleteBlobIfUnused(row.source_sha, "source");
				db.prepare("UPDATE reports SET resolved = 1 WHERE release_id = ?").run(row.id);
				logEvent("admin", "release.remove", `${row.slug}@${row.version}`);
				return json(res, 200, { ok: true });
			}
			return fail(res, 404, "no such admin endpoint");
		}

		return fail(res, 404, "no such API endpoint");
	}

	return {
		config,
		server,
		db,
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
			if (demoTimer) clearInterval(demoTimer);
			await new Promise((resolvePromise) => server.close(resolvePromise));
			db.close();
		},
	};
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const store = createStore();
	const address = await store.listen();
	const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
	console.log(
		`cubby: ${store.config.name} on http://${where} (data ${store.config.dataDir}, review ${store.config.requireReview ? "on" : "off"}, admin ${
			store.config.adminToken ? "on" : "disabled"
		})`,
	);
	const stop = async (signal) => {
		console.log(`cubby: ${signal}, shutting down`);
		await store.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	// A malformed request must not take the whole service down. Individual
	// handlers still catch and answer; this is the last-resort availability net.
	process.on("unhandledRejection", (reason) => console.error("cubby: unhandled rejection", reason));
}
