// Hamstr Store: a small, self-hostable catalog and blob host for Hamstr apps.
//
// Design rules (see README.md):
//  - The store never builds or executes an applet. Publishers upload a packed
//    bundle (tools/pack.ts output) and the store validates its shape, stores it
//    by SHA-256, and serves it back.
//  - Uploads are two steps (metadata, then bytes) so a bad manifest fails before
//    a large body is sent and the raw body stays streamable.
//  - Accounts exist only for publishing: browsing, trying and downloading are
//    public. Publishers sign in with a token (the CLI) or a session cookie (the
//    web). Optional review mode keeps new releases out of the catalog until a
//    moderator approves them.
//  - Moderation is a separate, LAN-only site (moderation/) on the same Postgres
//    database. The public store has no admin endpoints at all.
//  - One process, one Postgres database (embedded when DATABASE_URL is unset),
//    one blob directory: easy to back up.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BUNDLE_LIMITS, BundleError, readBundle } from "../packages/app-format/bundle.ts";
import { CATEGORIES, ManifestError, validateManifest, validatePublisherName, validateSlug, validateVersion } from "../packages/app-format/manifest.ts";
import { type Db, importSqlite, isUniqueViolation, migrate, openDb, type Sql } from "./db.ts";
import { refusePublisherName } from "./names.ts";
import { logEvent, publishRelease, readSettings, REJECTED_KEEP_DAYS, setTags, type StoreSettings } from "./releases.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// The web UI: a SvelteKit single-page app built into web/build (see web/).
const WEB_DIR = join(HERE, "web", "build");
const scryptAsync = promisify(scrypt) as (password: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>;

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
	".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const strip = (value: unknown): string => String(value ?? "").replace(/\/+$/, "");
const bytes = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

const SESSION_COOKIE = "store_session";
const SESSION_DAYS = 30;
const TOKEN_RE = /^cub_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

/** What the store reads from its environment or from tests. */
export interface StoreOptions {
	port?: number | string;
	host?: string;
	dataDir?: string;
	/** Postgres connection string; unset = embedded Postgres in <dataDir>/pg. */
	databaseUrl?: string;
	/** An open database to use instead (tests share one with the moderation site). */
	db?: Db;
	requireReview?: boolean;
	/** A request header the proxy in front sets to the visitor's address. */
	clientIpHeader?: string;
	rateLimit?: boolean;
	logging?: boolean;
	name?: string;
	demoApi?: string;
	demoToken?: string;
	demoHost?: string;
	demoDomain?: string;
	demoScheme?: string;
	demoTtl?: number | string;
	demoMax?: number | string;
	demoPerHour?: number | string;
	/** How long the demo node's load is trusted before it is read again. */
	demoStateMs?: number;
	/** A directory with the operator's impressum.html and datenschutz.html. */
	legalDir?: string;
	webDir?: string;
}

export function createStore(options: StoreOptions = {}) {
	const config = {
		port: Number(options.port ?? process.env.PORT ?? 3000),
		host: options.host ?? process.env.HOST ?? "0.0.0.0",
		dataDir: resolve(options.dataDir ?? process.env.STORE_DATA_DIR ?? "/data"),
		databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL ?? "",
		requireReview: options.requireReview ?? process.env.STORE_REQUIRE_REVIEW === "1",
		clientIpHeader: String(options.clientIpHeader ?? process.env.STORE_CLIENT_IP_HEADER ?? "").toLowerCase(),
		// The operator's legal notice and privacy policy (in Germany a public
		// site needs both): either links elsewhere (http(s) URLs), or HTML pages
		// in STORE_LEGAL_DIR (impressum.html, datenschutz.html) the store serves
		// at /impressum and /datenschutz. They are the operator's, not part of
		// this repository.
		legal: {
			imprint: /^https?:\/\//.test(process.env.STORE_IMPRINT_URL ?? "") ? process.env.STORE_IMPRINT_URL : null,
			privacy: /^https?:\/\//.test(process.env.STORE_PRIVACY_URL ?? "") ? process.env.STORE_PRIVACY_URL : null,
		},
		legalDir: options.legalDir ?? process.env.STORE_LEGAL_DIR ?? "",
		rateLimit: options.rateLimit !== false,
		logging: options.logging !== false,
		maxBundle: BUNDLE_LIMITS.compressed,
		maxSource: 16 * 1024 * 1024,
		maxApps: 20,
		maxReleases: 50,
		maxPublisherBytes: 300 * 1024 * 1024,
		name: options.name ?? "Hamstr Store",
		demo: {
			api: strip(options.demoApi ?? process.env.STORE_DEMO_API ?? ""),
			token: options.demoToken ?? process.env.STORE_DEMO_ADMIN_TOKEN ?? "",
			host: options.demoHost ?? process.env.STORE_DEMO_HOST ?? "demo-admin.internal",
			domain: String(options.demoDomain ?? process.env.STORE_DEMO_DOMAIN ?? "").replace(/^\.+/, ""),
			scheme: options.demoScheme ?? process.env.STORE_DEMO_SCHEME ?? "https",
			ttl: Number(options.demoTtl ?? process.env.STORE_DEMO_TTL_SECS ?? 900),
			max: Number(options.demoMax ?? process.env.STORE_DEMO_MAX ?? 100),
			perHour: Number(options.demoPerHour ?? process.env.STORE_DEMO_PER_HOUR ?? 10),
			stateMs: Number(options.demoStateMs ?? 10_000),
		},
	};
	const demoOn = Boolean(config.demo.api && config.demo.token && config.demo.domain);

	const frameSrc = demoOn ? `${config.demo.scheme}://*.${config.demo.domain}` : "'none'";
	const webDir = resolve(options.webDir ?? WEB_DIR);
	// The app shell (index.html) starts SvelteKit with one inline script; the CSP
	// allows exactly that script by its hash. Read once, on first use.
	let shell;
	const appShell = () => {
		if (shell !== undefined) return shell;
		const file = join(webDir, "index.html");
		if (!existsSync(file)) return (shell = null);
		const body = readFileSync(file);
		const hashes = [...body.toString("utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
		);
		return (shell = { body, scriptSrc: ["'self'", ...hashes].join(" ") });
	};
	const security = (scriptSrc = "'self'") => ({
		...SECURITY_HEADERS,
		"content-security-policy": `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src ${scriptSrc}; connect-src 'self'; font-src 'self'; frame-src ${frameSrc}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
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

	// The database opens in listen(): createStore stays synchronous for callers.
	let db: Db = options.db ?? null;
	const ownsDb = !options.db;
	async function init() {
		if (!db) db = await openDb({ url: config.databaseUrl || undefined, dir: config.databaseUrl ? undefined : join(config.dataDir, "pg") });
		await migrate(db);
		await importSqlite(db, config.dataDir);
		// Abandoned publishes (metadata created, bundle never uploaded) do not hold
		// a slot forever.
		await db.run("DELETE FROM releases WHERE status = 'uploading' AND created_at < now() - interval '24 hours'");
		await sweepBlobs();
	}

	/** Delete the files of releases that are gone: removed ones, and rejected
	 *  ones past their keep time (the moderation site cannot delete files). Only
	 *  files the database knows to be dead go: a file it does not know at all is
	 *  left alone, so an empty or wrong database never empties the blob store. */
	async function sweepBlobs() {
		const rows = await db.query(
			`SELECT bundle_sha, source_sha, (status = 'removed' OR (status = 'rejected' AND reviewed_at <= now() - make_interval(days => $1))) AS dead FROM releases
			 WHERE bundle_sha IS NOT NULL OR source_sha IS NOT NULL`,
			[REJECTED_KEEP_DAYS],
		);
		const live = new Set<string>();
		const dead = new Set<string>();
		for (const row of rows) {
			const into = row.dead ? dead : live;
			if (row.bundle_sha) into.add(`${row.bundle_sha}.tgz`);
			if (row.source_sha) into.add(`source-${row.source_sha}.tgz`);
		}
		for (const name of dead) if (!live.has(name)) rmSync(join(blobsDir, name), { force: true });
	}
	let sweepTimer = null;

	// Registration and publishing switches, set on the moderation site. Read at
	// most every few seconds.
	let settingsCache: { at: number; value: StoreSettings } = null;
	async function settings(): Promise<StoreSettings> {
		if (settingsCache && Date.now() - settingsCache.at < 5000) return settingsCache.value;
		settingsCache = { at: Date.now(), value: await readSettings(db) };
		return settingsCache.value;
	}

	// Apps are addressed as <publisher>/<name> (apps.ref); the URL patterns
	// below capture that as one group.
	const appByRef = (ref: string) => db.one("SELECT * FROM apps WHERE ref = $1", [ref]);
	const releaseById = (id: number) =>
		db.one("SELECT r.*, a.ref, a.publisher_id, a.name AS app_name FROM releases r JOIN apps a ON a.id = r.app_id WHERE r.id = $1", [id]);
	const releaseByVersion = (ref: string, version: string) =>
		db.one(
			"SELECT r.*, p.suspended_at AS publisher_suspended FROM releases r JOIN apps a ON a.id = r.app_id JOIN publishers p ON p.id = a.publisher_id WHERE a.ref = $1 AND r.version = $2",
			[ref, version],
		);

	// --- passwords, tokens and sessions ----------------------------------------
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
	// A wrong name costs the same as a wrong password, so timing does not tell
	// which names exist.
	const decoyHash = hashPassword(randomBytes(12).toString("hex"));
	async function issueToken(sql: Sql, publisherId: number, kind: "cli" | "session" = "cli"): Promise<string> {
		const id = randomBytes(6).toString("hex");
		const secret = randomBytes(32).toString("base64url");
		const expires = kind === "session" ? new Date(Date.now() + SESSION_DAYS * 86400_000) : null;
		await sql.query("INSERT INTO tokens (id, publisher_id, hash, kind, created_at, expires_at) VALUES ($1, $2, $3, $4, now(), $5)", [id, publisherId, sha256(secret), kind, expires]);
		return `cub_${id}_${secret}`;
	}
	const cookieOf = (req: IncomingMessage, name: string): string => {
		for (const part of String(req.headers.cookie ?? "").split(";")) {
			const [key, ...rest] = part.trim().split("=");
			if (key === name) return rest.join("=");
		}
		return "";
	};
	/** A cookie-signed request that changes something must come from the store's
	 *  own pages: SameSite=Strict already keeps other sites' requests from
	 *  carrying the cookie, and the Origin check covers browsers that ignore it. */
	function sameOrigin(req: IncomingMessage): boolean {
		const origin = String(req.headers.origin ?? "");
		if (!origin) return false;
		try {
			return new URL(origin).host === String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
		} catch {
			return false;
		}
	}
	interface Me {
		id: number;
		name: string;
		tokenId: string;
		via: "token" | "session";
	}
	/** Whether a token row matches the presented secret, is unexpired and is of
	 *  the kind (CLI token or web session) the request came with. */
	function tokenUsable(row, secret: string, via: "token" | "session"): boolean {
		const got = Buffer.from(sha256(secret), "hex");
		const want = Buffer.from(row.hash, "hex");
		if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
		if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false;
		// A CLI token is not a web session and the other way round.
		return (via === "session") === (row.kind === "session");
	}
	/** A web session may only change things from the store's own pages. */
	function requireSameOrigin(req: IncomingMessage, method: string): void {
		if (method === "GET" || method === "HEAD" || sameOrigin(req)) return;
		throw new HttpError(403, "this request did not come from the store's own pages");
	}
	/** The publisher behind a request: a Bearer token (the CLI) or the session
	 *  cookie (the web). Throws 403 for a suspended publisher. */
	async function authenticate(req: IncomingMessage, method: string): Promise<Me | null> {
		const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
		const raw = bearer ?? decodeURIComponent(cookieOf(req, SESSION_COOKIE));
		const match = TOKEN_RE.exec(raw ?? "");
		if (!match) return null;
		const via = bearer ? "token" : "session";
		if (via === "session") requireSameOrigin(req, method);
		const row = await db.one(
			"SELECT t.*, p.name AS publisher, p.suspended_at, p.suspended_reason FROM tokens t JOIN publishers p ON p.id = t.publisher_id WHERE t.id = $1",
			[match[1]],
		);
		if (!row || !tokenUsable(row, match[2], via)) return null;
		if (row.suspended_at) throw new HttpError(403, `this publisher account is suspended${row.suspended_reason ? `: ${row.suspended_reason}` : ""}`);
		await db.run("UPDATE tokens SET last_used_at = now() WHERE id = $1", [row.id]);
		return { id: row.publisher_id, name: row.publisher, tokenId: row.id, via };
	}
	const sessionCookie = (req: IncomingMessage, value: string, maxAge: number) => {
		const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
		return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
	};

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
	// Rate limits are per visitor, so they need the visitor's address. Behind
	// more than one proxy the last X-Forwarded-For hop is a proxy, and every
	// visitor would share one bucket. Name a header your proxy sets itself
	// (Traefik: x-real-ip) to use instead; never one a client can send.
	const clientIp = (req) => {
		const trusted = config.clientIpHeader ? String(req.headers[config.clientIpHeader] ?? "").trim() : "";
		if (trusted) return trusted;
		const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		return forwarded[forwarded.length - 1] || req.socket.remoteAddress || "?";
	};
	const tooMany = (res) => json(res, 429, { error: "too many requests, slow down" }, { "retry-after": "60" });
	// Old buckets would otherwise pile up, one per client address.
	const bucketTimer = setInterval(() => {
		const at = Date.now();
		for (const [key, bucket] of buckets) if (bucket.reset <= at) buckets.delete(key);
	}, 10 * 60 * 1000);
	bucketTimer.unref();

	// --- helpers --------------------------------------------------------------
	function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
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

	async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<any> {
		const length = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(length) && length > limit) throw new HttpError(413, "request body is too large");
		const chunks: Buffer[] = [];
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
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const out = createWriteStream(dest, { flags: "wx", mode: 0o600 });
			const done = (err?: unknown) => {
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

	const manifestOf = (row) => (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest);
	const tagsOf = (app) => {
		if (Array.isArray(app.tags)) return app.tags;
		try {
			return JSON.parse(app.tags);
		} catch {
			return [];
		}
	};

	function releaseView(row, { owner = false, includeManifest = false } = {}) {
		return {
			version: row.version,
			status: row.status,
			createdAt: row.created_at,
			publishedAt: row.published_at,
			downloads: row.downloads,
			bundleSha256: row.bundle_sha,
			bundleSize: row.bundle_size,
			sourceSha256: row.source_sha,
			sourceSize: row.source_size,
			...(owner && { id: row.id, reviewedAt: row.reviewed_at ?? null, reviewNote: row.review_note ?? null }),
			...(includeManifest && { manifest: manifestOf(row) }),
		};
	}

	function cardView(app) {
		return {
			id: app.ref,
			slug: app.slug,
			name: app.name,
			summary: app.summary,
			icon: app.icon,
			license: app.license,
			category: app.category ?? null,
			tags: tagsOf(app),
			publisher: app.publisher,
			version: app.version,
			releaseCount: Number(app.release_count ?? 0),
			downloads: Number(app.downloads ?? 0),
			updatedAt: app.updated_at,
		};
	}

	async function appStorage(publisherId: number): Promise<number> {
		const row = await db.one(
			"SELECT COALESCE(SUM(r.bundle_size + r.source_size), 0)::bigint AS total FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = $1 AND r.status NOT IN ('removed', 'rejected')",
			[publisherId],
		);
		return Number(row?.total ?? 0);
	}

	async function deleteBlobIfUnused(sha, kind = "bundle") {
		if (!sha) return;
		const column = kind === "source" ? "source_sha" : "bundle_sha";
		const used = await db.one(`SELECT 1 FROM releases WHERE ${column} = $1 AND status NOT IN ('removed', 'rejected') LIMIT 1`, [sha]);
		if (used) return;
		rmSync(join(blobsDir, `${kind === "source" ? "source-" : ""}${sha}.tgz`), { force: true });
	}

	// Versions are immutable: a release that ever had a bundle is never deleted,
	// only emptied. Its row stays (status "removed", hashes kept) and its files
	// go, so the version can never be published again with other content. A
	// release whose upload never finished held nothing and is deleted outright.
	async function removeRelease(sql: Sql, row) {
		if (!row.bundle_sha && !row.source_sha) {
			await sql.run("DELETE FROM releases WHERE id = $1", [row.id]);
			return;
		}
		await sql.run("UPDATE releases SET status = 'removed' WHERE id = $1", [row.id]);
	}
	async function deleteFilesOf(row) {
		await deleteBlobIfUnused(row.bundle_sha);
		await deleteBlobIfUnused(row.source_sha, "source");
	}

	// --- demo sessions --------------------------------------------------------
	// A demo is a real deploy to a separate celld node, on a random host, with no
	// egress and a short lifetime. The store never gets the production admin
	// token; config.demo.token only reaches the demo node.
	interface DemoResponse { status: number; body: string }
	function demoRequest(method: string, pathname: string, body?: string | Buffer, contentType = "application/json", timeout = 90_000): Promise<DemoResponse> {
		const base = new URL(config.demo.api);
		return new Promise<DemoResponse>((resolvePromise, rejectPromise) => {
			const headers: Record<string, string | number> = { Host: config.demo.host, authorization: `Bearer ${config.demo.token}` };
			if (body !== undefined) {
				headers["content-type"] = contentType;
				headers["content-length"] = Buffer.byteLength(body);
			}
			const req = httpRequest(
				{ hostname: base.hostname, port: base.port || 80, path: `/__admin${pathname}`, method, headers, timeout },
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
	async function demoJson(method: string, pathname: string, body?: unknown): Promise<any> {
		const result = await demoRequest(method, pathname, body === undefined ? undefined : JSON.stringify(body));
		let parsed: any = {};
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
		if (!demoOn || !db) return;
		const due = await db.query("SELECT * FROM demos WHERE status IN ('starting', 'running') AND expires_at <= now()");
		for (const row of due) {
			if (!(await deleteDemoSite(row.host))) continue;
			await db.run("UPDATE demos SET status = 'expired' WHERE id = $1", [row.id]);
		}
		await db.run("DELETE FROM demos WHERE status = 'expired' AND created_at < now() - interval '24 hours'");
		// The demo bucket is disposable; keep its code blobs from accumulating.
		if (Date.now() - lastDemoPrune > 10 * 60 * 1000) {
			lastDemoPrune = Date.now();
			await demoRequest("POST", "/prune?confirm=prune&keep=0&orphanAge=300").catch(() => {});
		}
	}
	let lastDemoPrune = 0;

	// Load: "Try it" disappears while every slot is taken, while the demo node
	// says it is short of memory (or draining), and for two minutes after it
	// failed to start a demo. The node's state is read at most every 10 s.
	let demoState = { at: 0, ok: true };
	let demoStateRead: Promise<void> = null;
	let demoFailedAt = 0;
	async function demoBusy(): Promise<string | null> {
		const running = Number((await db.one("SELECT count(*)::int AS n FROM demos WHERE status IN ('starting', 'running') AND expires_at > now()"))?.n ?? 0);
		if (running >= config.demo.max) return "all demo slots are busy; try again in a few minutes";
		if (Date.now() - demoFailedAt < 120_000) return "demos are resting for a moment; try again in a few minutes";
		if (Date.now() - demoState.at >= config.demo.stateMs) {
			demoStateRead ??= demoRequest("GET", "/state", undefined, "application/json", 3000)
				.then((r) => {
					const load = r.status === 200 ? JSON.parse(r.body)?.node_load ?? {} : null;
					demoState = { at: Date.now(), ok: Boolean(load) && !load.pressured && !load.draining && load.memory_headroom !== false };
				})
				.catch(() => {
					demoState = { at: Date.now(), ok: false };
				})
				.finally(() => (demoStateRead = null));
			await demoStateRead;
		}
		return demoState.ok ? null : "the demo server is busy; try again in a few minutes";
	}
	let demoTimer = null;

	// --- the operator's legal pages ---------------------------------------------
	const LEGAL_PAGES = { "/impressum": "impressum.html", "/datenschutz": "datenschutz.html" };
	const legalFile = (path: string) => (config.legalDir && LEGAL_PAGES[path] ? join(config.legalDir, LEGAL_PAGES[path]) : null);
	function legalPage(path: string): Buffer | null {
		const file = legalFile(path);
		return file && existsSync(file) ? readFileSync(file) : null;
	}
	/** Footer links: a configured URL, else the page this store serves, else none. */
	const legalLinks = () => ({
		imprint: config.legal.imprint ?? (existsSync(legalFile("/impressum") ?? "") ? "/impressum" : null),
		privacy: config.legal.privacy ?? (existsSync(legalFile("/datenschutz") ?? "") ? "/datenschutz" : null),
	});

	// --- static UI ------------------------------------------------------------
	// Files from the build are served as they are; any other path without a file
	// extension is a page of the single-page app and gets the app shell.
	function serveStatic(req, res, pathname) {
		let rel;
		try {
			rel = decodeURIComponent(pathname);
		} catch {
			return false;
		}
		const file = resolve(join(webDir, rel));
		if (file.startsWith(webDir + sep) && !file.endsWith(`${sep}index.html`) && existsSync(file) && statSync(file).isFile()) {
			const body = readFileSync(file);
			res.writeHead(200, {
				...security(),
				"content-type": MIME[extname(file)] ?? "application/octet-stream",
				"content-length": body.length,
				"cache-control": rel.startsWith("/_app/immutable/") ? "public, max-age=31536000, immutable" : "public, max-age=300",
			});
			res.end(req.method === "HEAD" ? undefined : body);
			return true;
		}
		if (extname(rel)) return false;
		const legal = legalPage(rel);
		if (legal) {
			res.writeHead(200, { ...security(), "content-type": "text/html; charset=utf-8", "content-length": legal.length, "cache-control": "no-cache" });
			res.end(req.method === "HEAD" ? undefined : legal);
			return true;
		}
		const app = appShell();
		if (!app) {
			res.writeHead(503, { ...security(), "content-type": "text/plain; charset=utf-8" }).end("The store's web UI is not built: run `npm run build` in store/web.\n");
			return true;
		}
		res.writeHead(200, {
			...security(app.scriptSrc),
			"content-type": "text/html; charset=utf-8",
			"content-length": app.body.length,
			"cache-control": "no-cache",
		});
		res.end(req.method === "HEAD" ? undefined : app.body);
		return true;
	}

	// --- HTTP -----------------------------------------------------------------
	/** The HTTP status an error maps to, and what the client is told. */
	function errorReply(err): { status: number; message: string } {
		const unique = isUniqueViolation(err);
		const status = err instanceof HttpError ? err.status : err instanceof ManifestError || err instanceof BundleError ? 422 : unique ? 409 : 500;
		if (status === 500) console.error("store: request failed", err);
		if (status === 500) return { status, message: "internal error" };
		return { status, message: status === 409 && unique ? "someone else just took that name or version" : err.message };
	}
	/** Route one request: the API, the static web app, or a refusal. */
	async function route(req, res, method: string, pathname: string, url: URL): Promise<void> {
		if (pathname.startsWith("/api/")) return api(req, res, method, pathname, url);
		if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method not allowed");
		if (!serveStatic(req, res, pathname)) res.writeHead(404, { ...security(), "content-type": "text/plain; charset=utf-8" }).end("not found\n");
	}
	const server = createServer(async (req, res) => {
		const started = Date.now();
		// Never build this from the Host header: a client-controlled value such as
		// `Host: store.localhost:abc` throws from the URL parser. The router only
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
			await route(req, res, method, pathname, url);
		} catch (err) {
			const { status, message } = errorReply(err);
			if (!res.headersSent) fail(res, status, message);
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

	// Apps whose publisher is suspended are not in the catalog.
	const LISTED = `p.suspended_at IS NULL AND EXISTS (SELECT 1 FROM releases r WHERE r.app_id = a.id AND r.status = 'published')`;

	/** Whether the "try it" button is on offer for an app, and why not. */
	async function demoOffer(releases) {
		const published = releases.find((r) => r.status === "published");
		const reason = demoUnavailable(published);
		// Under load the button goes away instead of failing when pressed.
		const busy = reason ? null : await demoBusy();
		return { enabled: demoOn, available: !reason && !busy, reason: reason ?? busy, busy: Boolean(busy) };
	}
	function demoUnavailable(published): string | null {
		if (!demoOn) return "demos are not enabled on this store";
		if (!published) return "no published release";
		if ((manifestOf(published)?.egress?.length ?? 0) > 0) return "this app needs network access; install it to try it";
		return null;
	}

	async function api(req, res, method, pathname, url) {
		// Public reads and account endpoints.
		if (method === "GET" && pathname === "/api/health") {
			const apps = (await db.one(`SELECT count(*)::int AS n FROM apps a JOIN publishers p ON p.id = a.publisher_id WHERE ${LISTED}`)).n;
			const releases = (await db.one("SELECT count(*)::int AS n FROM releases WHERE status = 'published'")).n;
			const switches = await settings();
			return json(res, 200, { ok: true, name: config.name, apps, releases, review: config.requireReview, ...switches, legal: legalLinks() });
		}

		if (pathname === "/api/v1/publishers" && method === "POST") {
			if (rateLimited(`register:${clientIp(req)}`, 5, 60 * 60 * 1000)) return tooMany(res);
			if (!(await settings()).registration) return fail(res, 503, "new publisher accounts are paused; try again later");
			const body = await readJson(req, 16 * 1024);
			const name = validatePublisherName(String(body.name ?? ""));
			const password = String(body.password ?? "");
			if (password.length < 10 || password.length > 200) throw new HttpError(400, "password must be 10-200 characters");
			if (body.acceptPolicy !== true) throw new HttpError(400, "accept the content policy (/policy) to create a publisher account");
			if (await db.one("SELECT 1 FROM publishers WHERE name = $1", [name])) throw new HttpError(409, "that publisher name is taken");
			// The name is the namespace of every app the publisher makes: no
			// reserved names, nothing that reads like someone else's.
			const refused = refusePublisherName(name, (await db.query("SELECT name FROM publishers")).map((r) => r.name));
			if (refused) throw new HttpError(409, refused);
			const hash = await hashPassword(password);
			const kind = body.session === true ? "session" : "cli";
			const token = await db.tx(async (sql) => {
				const row = await sql.one("INSERT INTO publishers (name, password, created_at, policy_accepted_at) VALUES ($1, $2, now(), now()) RETURNING id", [name, hash]);
				await logEvent(sql, name, "register", name);
				return issueToken(sql, row.id, kind);
			});
			// The web signs in at once; the CLI gets its token.
			if (kind === "session") return json(res, 201, { publisher: { name } }, { "set-cookie": sessionCookie(req, token, SESSION_DAYS * 86400) });
			return json(res, 201, { publisher: { name }, token });
		}

		// Password sign-in: a CLI token (POST /tokens) or a web session (POST /session).
		if ((pathname === "/api/v1/tokens" || pathname === "/api/v1/session") && method === "POST") {
			const web = pathname === "/api/v1/session";
			// A signed-in web session can mint a CLI token without the password.
			if (!web && !String(req.headers.authorization ?? "") && cookieOf(req, SESSION_COOKIE)) {
				const me = await authenticate(req, method);
				if (!me) return fail(res, 401, "sign in first");
				const token = await issueToken(db, me.id, "cli");
				await logEvent(db, me.name, "token.create", me.name);
				return json(res, 201, { token });
			}
			if (rateLimited(`login:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 16 * 1024);
			const name = String(body.name ?? "");
			const password = String(body.password ?? "");
			const publisher = await db.one("SELECT * FROM publishers WHERE name = $1", [name]);
			const ok = await checkPassword(password, publisher?.password ?? (await decoyHash));
			if (!publisher || !ok) throw new HttpError(401, "wrong name or password");
			if (publisher.suspended_at) throw new HttpError(403, `this publisher account is suspended${publisher.suspended_reason ? `: ${publisher.suspended_reason}` : ""}`);
			const token = await issueToken(db, publisher.id, web ? "session" : "cli");
			if (web) return json(res, 201, { publisher: { name } }, { "set-cookie": sessionCookie(req, token, SESSION_DAYS * 86400) });
			return json(res, 201, { token });
		}

		const me = await authenticate(req, method);
		if (pathname === "/api/v1/session" && method === "DELETE") {
			if (me?.via === "session") await db.run("DELETE FROM tokens WHERE id = $1", [me.tokenId]);
			return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, "", 0) });
		}
		if (pathname === "/api/v1/me" && method === "GET") {
			if (!me) return fail(res, 401, "sign in first");
			const publisher = await db.one("SELECT id, name, created_at, trusted, policy_accepted_at FROM publishers WHERE id = $1", [me.id]);
			const apps = await db.query("SELECT * FROM apps WHERE publisher_id = $1 ORDER BY updated_at DESC", [me.id]);
			const releases = await db.query("SELECT r.* FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = $1 ORDER BY r.created_at DESC", [me.id]);
			const tokens = await db.one("SELECT count(*)::int AS n, max(last_used_at) AS last FROM tokens WHERE publisher_id = $1 AND kind = 'cli'", [me.id]);
			return json(res, 200, {
				publisher: { name: me.name, createdAt: publisher.created_at, trusted: publisher.trusted, policyAcceptedAt: publisher.policy_accepted_at },
				storageUsed: await appStorage(me.id),
				storageLimit: config.maxPublisherBytes,
				review: config.requireReview,
				cliTokens: { count: tokens.n, lastUsedAt: tokens.last },
				apps: apps.map((app) => ({
					...cardView({ ...app, publisher: me.name, version: null, release_count: 0, downloads: 0 }),
					releases: releases.filter((r) => r.app_id === app.id).map((r) => releaseView(r, { owner: true, includeManifest: true })),
				})),
			});
		}
		if (pathname === "/api/v1/me/password" && method === "POST") {
			if (!me) return fail(res, 401, "sign in first");
			if (rateLimited(`login:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 16 * 1024);
			const next = String(body.next ?? "");
			if (next.length < 10 || next.length > 200) throw new HttpError(400, "password must be 10-200 characters");
			const row = await db.one("SELECT password FROM publishers WHERE id = $1", [me.id]);
			if (!(await checkPassword(String(body.current ?? ""), row.password))) throw new HttpError(401, "the current password is wrong");
			const hash = await hashPassword(next);
			await db.tx(async (sql) => {
				await sql.run("UPDATE publishers SET password = $1, password_changed_at = now() WHERE id = $2", [hash, me.id]);
				// Every other sign-in ends; this one stays.
				await sql.run("DELETE FROM tokens WHERE publisher_id = $1 AND id != $2", [me.id, me.tokenId]);
				await logEvent(sql, me.name, "password.change", me.name);
			});
			return json(res, 200, { ok: true });
		}
		if (pathname === "/api/v1/tokens" && method === "DELETE") {
			if (!me) return fail(res, 401, "sign in first");
			// Every CLI token; a web session that asks keeps itself.
			await db.run("DELETE FROM tokens WHERE publisher_id = $1 AND (kind = 'cli' OR id = $2)", [me.id, me.via === "token" ? me.tokenId : ""]);
			await logEvent(db, me.name, "token.revoke", me.name);
			return json(res, 200, { ok: true });
		}

		// Catalog.
		if (pathname === "/api/v1/apps" && method === "GET") {
			const search = String(url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
			const tag = String(url.searchParams.get("tag") ?? "").trim().toLowerCase().slice(0, 20);
			const category = String(url.searchParams.get("category") ?? "").trim().toLowerCase().slice(0, 20);
			const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
			const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
			const where = `${LISTED}
				AND ($1 = '' OR strpos(lower(a.name || ' ' || a.summary || ' ' || a.description || ' ' || a.tags::text), $1) > 0)
				AND ($2 = '' OR EXISTS (SELECT 1 FROM app_tags t WHERE t.tag = $2 AND t.app_id = a.id))
				AND ($3 = '' OR a.category = $3)`;
			const args = [search, tag, category];
			const rows = await db.query(
				`SELECT a.*, p.name AS publisher,
					(SELECT version FROM releases r WHERE r.app_id = a.id AND r.status = 'published' ORDER BY r.published_at DESC LIMIT 1) AS version,
					(SELECT COUNT(*)::int FROM releases r WHERE r.app_id = a.id AND r.status = 'published') AS release_count,
					(SELECT COALESCE(SUM(r.downloads), 0)::int FROM releases r WHERE r.app_id = a.id AND r.status = 'published') AS downloads
				 FROM apps a JOIN publishers p ON p.id = a.publisher_id
				 WHERE ${where}
				 ORDER BY a.updated_at DESC LIMIT $4 OFFSET $5`,
				[...args, limit, offset],
			);
			const total = (await db.one(`SELECT COUNT(*)::int AS n FROM apps a JOIN publishers p ON p.id = a.publisher_id WHERE ${where}`, args)).n;
			return json(res, 200, { apps: rows.map(cardView), total, limit, offset });
		}

		// The browse sections, in their fixed order, with how many listed apps
		// each holds. `uncategorized` counts listed apps without one.
		if (pathname === "/api/v1/categories" && method === "GET") {
			const rows = await db.query(`SELECT a.category, COUNT(*)::int AS n FROM apps a JOIN publishers p ON p.id = a.publisher_id WHERE ${LISTED} GROUP BY a.category`);
			const counts = new Map(rows.map((r) => [r.category, Number(r.n)]));
			return json(res, 200, {
				categories: Object.entries(CATEGORIES).map(([id, label]) => ({ id, label, count: counts.get(id) ?? 0 })),
				uncategorized: counts.get(null) ?? 0,
			});
		}

		// Before namespaces an app was /api/v1/apps/<name>. Those apps (and only
		// those: a new app never gets a bare name) still answer there, by redirect.
		const legacy = /^\/api\/v1\/apps\/([a-z0-9-]+)((?:\/releases\/[^/]+\/(?:download|source))?)$/.exec(pathname);
		if (legacy && (method === "GET" || method === "HEAD")) {
			const app = await db.one("SELECT ref FROM apps WHERE slug = $1 AND legacy", [legacy[1]]);
			if (!app) return fail(res, 404, "no such app; apps are addressed as <publisher>/<app>");
			res.writeHead(308, { ...security(), location: `/api/v1/apps/${app.ref}${legacy[2]}${url.search}`, "cache-control": "public, max-age=3600" });
			return res.end();
		}
		if (/^\/api\/v1\/apps\/[a-z0-9-]+\/releases$/.test(pathname) && method === "POST") {
			return fail(res, 410, "apps are now <publisher>/<app>: update the hamstr CLI (npm i -g @hamstr/cli) and publish again");
		}

		const appMatch = /^\/api\/v1\/apps\/([a-z0-9-]+\/[a-z0-9-]+)$/.exec(pathname);
		if (appMatch && method === "GET") {
			const app = await appByRef(appMatch[1]);
			if (!app) return fail(res, 404, "no such app");
			const owner = me && me.id === app.publisher_id;
			const publisher = await db.one("SELECT name, suspended_at FROM publishers WHERE id = $1", [app.publisher_id]);
			const releases = (await db.query("SELECT * FROM releases WHERE app_id = $1 ORDER BY created_at DESC", [app.id])).filter(
				(r) => owner || (r.status === "published" && !publisher.suspended_at),
			);
			if (!owner && releases.length === 0) return fail(res, 404, "no such app");
			const latest = releases.find((r) => r.status === "published") ?? releases[0];
			return json(res, 200, {
				app: {
					...cardView({
						...app,
						publisher: publisher.name,
						version: latest?.version ?? null,
						release_count: releases.filter((r) => r.status === "published").length,
						downloads: releases.reduce((n, r) => n + (r.status === "published" ? Number(r.downloads) : 0), 0),
					}),
					description: app.description,
					homepage: app.homepage,
					source: app.source,
					createdAt: app.created_at,
				},
				releases: releases.map((r) => releaseView(r, { owner, includeManifest: true })),
				demo: await demoOffer(releases),
				...(owner && { owner: true }),
			});
		}

		// Download (public).
		const downloadMatch = /^\/api\/v1\/apps\/([a-z0-9-]+\/[a-z0-9-]+)\/releases\/([^/]+)\/(download|source)$/.exec(pathname);
		if (downloadMatch && (method === "GET" || method === "HEAD")) {
			if (rateLimited(`download:${clientIp(req)}`, 600, 60 * 1000)) return tooMany(res);
			const [, ref, rawVersion, kind] = downloadMatch;
			const slug = ref.split("/")[1];
			if (!validateVersion(rawVersion)) return fail(res, 400, "bad version");
			const row = await releaseByVersion(ref, rawVersion);
			if (!row || row.publisher_suspended) return fail(res, 404, "no such release");
			if (row.status === "yanked") return fail(res, 410, "this release was withdrawn");
			if (row.status !== "published") return fail(res, 404, "no such release");
			const sha = kind === "download" ? row.bundle_sha : row.source_sha;
			if (!sha) return fail(res, 404, kind === "download" ? "this release has no bundle" : "this release has no source archive");
			const file = join(blobsDir, `${kind === "source" ? "source-" : ""}${sha}.tgz`);
			if (!existsSync(file)) return fail(res, 500, "stored bundle is missing");
			if (kind === "download") await db.run("UPDATE releases SET downloads = downloads + 1 WHERE id = $1", [row.id]);
			const size = statSync(file).size;
			res.writeHead(200, {
				...security(),
				"content-type": "application/gzip",
				"content-length": size,
				"x-bundle-sha256": sha,
				"content-disposition": `attachment; filename="${slug}-${rawVersion}.${kind === "download" ? "tgz" : "source.tgz"}"`,
				"cache-control": "public, max-age=31536000, immutable",
			});
			if (method === "HEAD") return res.end();
			return createReadStream(file).pipe(res);
		}

		// Interactive demo sessions: a throwaway site on the demo node.
		const demoStart = /^\/api\/v1\/apps\/([a-z0-9-]+\/[a-z0-9-]+)\/demo$/.exec(pathname);
		if (demoStart && method === "POST") {
			if (!demoOn) return fail(res, 503, "interactive demos are not enabled on this store");
			if (rateLimited(`demo:${clientIp(req)}`, config.demo.perHour, 60 * 60 * 1000)) return tooMany(res);
			const app = await db.one("SELECT a.* FROM apps a JOIN publishers p ON p.id = a.publisher_id WHERE a.ref = $1 AND p.suspended_at IS NULL", [demoStart[1]]);
			if (!app) return fail(res, 404, "no such app");
			const release = await db.one("SELECT * FROM releases WHERE app_id = $1 AND status = 'published' ORDER BY published_at DESC LIMIT 1", [app.id]);
			if (!release) return fail(res, 404, "no published release");
			const manifest = manifestOf(release);
			if ((manifest.egress ?? []).length) return fail(res, 409, "this app needs network access; install it to try it");
			if (!release.bundle_sha) return fail(res, 409, "this release has no bundle");
			const busy = await demoBusy();
			if (busy) return fail(res, 503, busy);
			const { id, host } = newDemo();
			const endToken = randomBytes(24).toString("base64url");
			const ttl = Math.max(60, Math.min(3600, config.demo.ttl));
			const expires = new Date(Date.now() + ttl * 1000).toISOString();
			await db.run("INSERT INTO demos (id, app_id, version, host, created_at, expires_at, status, end_hash) VALUES ($1, $2, $3, $4, now(), $5, 'starting', $6)", [
				id,
				app.id,
				release.version,
				host,
				expires,
				sha256(endToken),
			]);
			try {
				const file = join(blobsDir, `${release.bundle_sha}.tgz`);
				if (!existsSync(file)) throw new HttpError(500, "stored bundle is missing");
				await deployDemo(file, host);
				await db.run("UPDATE demos SET status = 'running' WHERE id = $1", [id]);
				return json(res, 201, {
					id,
					url: `${config.demo.scheme}://${host}`,
					host,
					expiresAt: expires,
					app: { id: app.ref, slug: app.slug, name: app.name },
					version: release.version,
					endToken,
				});
			} catch (err) {
				await deleteDemoSite(host);
				await db.run("DELETE FROM demos WHERE id = $1", [id]);
				// The node failed (not the app's own deploy check): rest demos a while.
				if (!(err instanceof HttpError) || err.status >= 500) demoFailedAt = Date.now();
				return fail(res, err.status ?? 422, err.message);
			}
		}
		const demoView = /^\/api\/v1\/demos\/([a-f0-9]{12})$/.exec(pathname);
		if (demoView) {
			const row = await db.one("SELECT d.*, a.ref AS app_ref, a.slug AS app_slug, a.name AS app_name FROM demos d LEFT JOIN apps a ON a.id = d.app_id WHERE d.id = $1", [demoView[1]]);
			if (!row) return fail(res, 404, "no such demo");
			if (method === "GET") {
				return json(res, 200, {
					id: row.id,
					url: `${config.demo.scheme}://${row.host}`,
					host: row.host,
					version: row.version,
					expiresAt: row.expires_at,
					status: row.status,
					app: row.app_slug ? { id: row.app_ref, slug: row.app_slug, name: row.app_name } : null,
				});
			}
			if (method === "DELETE") {
				if (row.end_hash) {
					const supplied = String(req.headers["x-demo-token"] ?? "");
					const got = Buffer.from(sha256(supplied), "hex");
					const want = Buffer.from(String(row.end_hash), "hex");
					if (got.length !== want.length || !timingSafeEqual(got, want)) {
						return fail(res, 403, "the demo's end token is required");
					}
				}
				if (row.status === "running" || row.status === "starting") {
					const ok = await deleteDemoSite(row.host);
					if (!ok) return fail(res, 502, "could not stop the demo; it will expire on its own");
					await db.run("UPDATE demos SET status = 'expired' WHERE id = $1", [row.id]);
				}
				return json(res, 200, { ok: true });
			}
		}

		// Publishing.
		const newRelease = /^\/api\/v1\/apps\/([a-z0-9-]+)\/([a-z0-9-]+)\/releases$/.exec(pathname);
		if (newRelease && method === "POST") {
			if (!me) return fail(res, 401, "a publisher token is required");
			if (rateLimited(`publish:${me.id}`, 30, 60 * 60 * 1000)) return tooMany(res);
			if (!(await settings()).publishing) return fail(res, 503, "publishing is paused on this store; try again later");
			// A publisher's apps live under their own name and nowhere else.
			if (newRelease[1] !== me.name) return fail(res, 403, `you publish as ${me.name}/<app>, not under ${newRelease[1]}/`);
			const slug = validateSlug(newRelease[2]);
			const ref = `${me.name}/${slug}`;
			const body = await readJson(req, 64 * 1024);
			const manifest = validateManifest(body.manifest);
			if (manifest.slug !== slug) return fail(res, 422, `manifest slug ${manifest.slug} does not match ${slug}`);
			const app = await appByRef(ref);
			if (app && (await db.one("SELECT 1 FROM releases WHERE app_id = $1 AND version = $2", [app.id, manifest.version]))) {
				return fail(res, 409, `${ref}@${manifest.version} already exists`);
			}
			if (!app) {
				const count = Number((await db.one("SELECT COUNT(*)::int AS n FROM apps WHERE publisher_id = $1", [me.id]))?.n ?? 0);
				if (count >= config.maxApps) return fail(res, 403, `a publisher may have at most ${config.maxApps} apps`);
			}
			const releases = app ? Number((await db.one("SELECT COUNT(*)::int AS n FROM releases WHERE app_id = $1 AND status != 'removed'", [app.id]))?.n ?? 0) : 0;
			if (releases >= config.maxReleases) return fail(res, 403, `an app may have at most ${config.maxReleases} releases`);
			const release = await db.tx(async (sql) => {
				let appId = app?.id;
				if (!appId) {
					// The listing starts from the first manifest, but nobody sees it
					// until a release is published, which rewrites it.
					const row = await sql.one(
						"INSERT INTO apps (ref, slug, publisher_id, name, summary, description, homepage, source, license, icon, category, tags, created_at, updated_at) VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now(), now()) RETURNING id",
						[slug, me.id, manifest.name, manifest.summary, manifest.description, manifest.homepage ?? null, manifest.source ?? null, manifest.license, manifest.icon, manifest.category ?? null, JSON.stringify(manifest.tags), ref],
					);
					appId = row.id;
					await setTags(sql, appId, manifest.tags);
				}
				const row = await sql.one("INSERT INTO releases (app_id, version, manifest, status, created_at) VALUES ($1, $2, $3::jsonb, 'uploading', now()) RETURNING id", [
					appId,
					manifest.version,
					JSON.stringify(manifest),
				]);
				await logEvent(sql, me.name, "release.create", `${ref}@${manifest.version}`);
				return { id: row.id, appId };
			});
			return json(res, 201, {
				release: { id: release.id, version: manifest.version, status: "uploading" },
				upload: { method: "PUT", url: `/api/v1/releases/${release.id}/bundle`, maxBytes: config.maxBundle },
			});
		}

		const uploadMatch = /^\/api\/v1\/releases\/(\d+)\/(bundle|source)$/.exec(pathname);
		if (uploadMatch && method === "PUT") {
			if (!me) return fail(res, 401, "a publisher token is required");
			if (rateLimited(`upload:${me.id}`, 120, 60 * 60 * 1000)) return tooMany(res);
			const row = await releaseById(Number(uploadMatch[1]));
			if (!row) return fail(res, 404, "no such release");
			if (row.publisher_id !== me.id) return fail(res, 403, "not your release");
			if (row.status === "yanked") return fail(res, 409, "this release was yanked");
			if (row.status === "removed" || row.status === "rejected") return fail(res, 410, `this release was ${row.status}`);
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
				try {
					await readBundle(tmp);
				} catch (err) {
					rmSync(tmp, { force: true });
					if (err instanceof BundleError) return fail(res, 422, `invalid bundle: ${err.message}`);
					throw err;
				}
				const used = await appStorage(me.id);
				if (used + received.size > config.maxPublisherBytes) {
					rmSync(tmp, { force: true });
					return fail(res, 413, `publisher storage limit is ${bytes(config.maxPublisherBytes)}`);
				}
				const blob = join(blobsDir, `${received.sha}.tgz`);
				renameSync(tmp, blob); // same filesystem: atomic
				const status = config.requireReview ? "pending" : "published";
				const won = await db.tx(async (sql) => {
					// Compare-and-set: two uploads can both pass the read above, but
					// only one may become the bundle of this release. The loser's
					// blob is removed instead of leaking outside the quota.
					const changed = await sql.run("UPDATE releases SET bundle_sha = $1, bundle_size = $2, status = 'pending' WHERE id = $3 AND bundle_sha IS NULL", [
						received.sha,
						received.size,
						row.id,
					]);
					if (!changed) return false;
					// Without review a release goes straight out; the moderation
					// site still checks it afterwards and can take it down.
					if (status === "published") await publishRelease(sql, row.id);
					await logEvent(sql, me.name, status === "published" ? "release.publish" : "release.submit", `${row.ref}@${row.version}`, `sha256:${received.sha}`);
					return true;
				});
				if (!won) {
					await deleteBlobIfUnused(received.sha);
					return fail(res, 409, "another upload already completed this release");
				}
				return json(res, 201, { release: { id: row.id, version: row.version, status, bundleSha256: received.sha, bundleSize: received.size } });
			}

			if ((await appStorage(me.id)) + received.size > config.maxPublisherBytes) {
				rmSync(tmp, { force: true });
				return fail(res, 413, `publisher storage limit is ${bytes(config.maxPublisherBytes)}`);
			}
			const blob = join(blobsDir, `source-${received.sha}.tgz`);
			if (!existsSync(blob)) renameSync(tmp, blob);
			else rmSync(tmp, { force: true });
			const changed = await db.run("UPDATE releases SET source_sha = $1, source_size = $2 WHERE id = $3 AND source_sha IS NULL", [received.sha, received.size, row.id]);
			if (!changed) {
				await deleteBlobIfUnused(received.sha, "source");
				return fail(res, 409, "another source archive already completed this release");
			}
			return json(res, 201, { release: { id: row.id, version: row.version, sourceSha256: received.sha, sourceSize: received.size } });
		}

		// Owner operations: yank, delete release, delete app.
		const releaseOp = /^\/api\/v1\/releases\/(\d+)(?:\/(yank))?$/.exec(pathname);
		if (releaseOp) {
			if (!me) return fail(res, 401, "a publisher token is required");
			const row = await releaseById(Number(releaseOp[1]));
			if (!row) return fail(res, 404, "no such release");
			if (row.publisher_id !== me.id) return fail(res, 403, "not your release");
			if (releaseOp[2] === "yank" && method === "POST") {
				if (row.status !== "published" && row.status !== "pending") return fail(res, 409, `a ${row.status} release cannot be withdrawn`);
				await db.run("UPDATE releases SET status = 'yanked' WHERE id = $1", [row.id]);
				await logEvent(db, me.name, "release.yank", `${row.ref}@${row.version}`);
				return json(res, 200, { ok: true });
			}
			if (!releaseOp[2] && method === "DELETE") {
				// A rejected release stays as the moderators left it.
				if (row.status === "rejected") return fail(res, 409, "a rejected release cannot be deleted");
				await removeRelease(db, row);
				await deleteFilesOf(row);
				await logEvent(db, me.name, "release.delete", `${row.ref}@${row.version}`);
				return json(res, 200, { ok: true });
			}
		}

		const appDelete = /^\/api\/v1\/apps\/([a-z0-9-]+\/[a-z0-9-]+)$/.exec(pathname);
		if (appDelete && method === "DELETE") {
			if (!me) return fail(res, 401, "a publisher token is required");
			const app = await appByRef(appDelete[1]);
			if (!app) return fail(res, 404, "no such app");
			if (app.publisher_id !== me.id) return fail(res, 403, "not your app");
			// The app leaves the catalog and its files go, but its row and its
			// releases' versions stay: the name remains this publisher's, and no
			// version of it can come back with other content.
			const rows = await db.query("SELECT * FROM releases WHERE app_id = $1 AND status NOT IN ('removed', 'rejected')", [app.id]);
			await db.tx(async (sql) => {
				for (const row of rows) await removeRelease(sql, row);
				await logEvent(sql, me.name, "app.delete", app.ref);
			});
			for (const row of rows) await deleteFilesOf(row);
			return json(res, 200, { ok: true });
		}

		// Abuse reports: no account needed, rate-limited by IP. Moderators read
		// them on the moderation site.
		const reportMatch = /^\/api\/v1\/apps\/([a-z0-9-]+\/[a-z0-9-]+)\/releases\/([^/]+)\/report$/.exec(pathname);
		if (reportMatch && method === "POST") {
			if (rateLimited(`report:${clientIp(req)}`, 10, 60 * 60 * 1000)) return tooMany(res);
			const body = await readJson(req, 8 * 1024);
			const reason = String(body.reason ?? "").trim();
			if (reason.length < 5 || reason.length > 1000) throw new HttpError(400, "reason must be 5-1000 characters");
			if (!validateVersion(reportMatch[2])) return fail(res, 400, "bad version");
			const row = await releaseByVersion(reportMatch[1], reportMatch[2]);
			if (!row) return fail(res, 404, "no such release");
			await db.run("INSERT INTO reports (release_id, reason, created_at) VALUES ($1, $2, now())", [row.id, reason]);
			return json(res, 202, { ok: true });
		}

		return fail(res, 404, "no such API endpoint");
	}

	return {
		config,
		server,
		get db() {
			return db;
		},
		async listen(port = config.port, host = config.host): Promise<AddressInfo> {
			await init();
			if (demoOn && !demoTimer) {
				setTimeout(() => cleanupDemos().catch((err) => console.error("store: demo cleanup failed", err)), 5000).unref();
				demoTimer = setInterval(() => cleanupDemos().catch((err) => console.error("store: demo cleanup failed", err)), 60_000);
				demoTimer.unref();
			}
			sweepTimer = setInterval(() => sweepBlobs().catch((err) => console.error("store: blob sweep failed", err)), 10 * 60 * 1000);
			sweepTimer.unref();
			return new Promise<AddressInfo>((resolvePromise, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolvePromise(server.address() as AddressInfo);
				});
			});
		},
		async close() {
			if (demoTimer) clearInterval(demoTimer);
			if (sweepTimer) clearInterval(sweepTimer);
			clearInterval(bucketTimer);
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
			if (ownsDb && db) await db.close();
		},
	};
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const store = createStore();
	const address = await store.listen();
	const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
	console.log(
		`store: ${store.config.name} on http://${where} (data ${store.config.dataDir}, database ${store.config.databaseUrl ? "postgres" : "embedded"}, review ${store.config.requireReview ? "on" : "off"})`,
	);
	const stop = async (signal) => {
		console.log(`store: ${signal}, shutting down`);
		await store.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	// A malformed request must not take the whole service down. Individual
	// handlers still catch and answer; this is the last-resort availability net.
	process.on("unhandledRejection", (reason) => console.error("store: unhandled rejection", reason));
}
