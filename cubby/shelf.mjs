// Cubby Shelf: the local, non-technical control panel for one celld node.
//
// It is deliberately separate from the public store: the store is a catalog,
// the shelf is the thing allowed to install. The shelf holds the celld admin
// token, so it must stay LAN/tailnet-only and behind an operator password.
// Installs reuse the same CLI and deploy path as `cubby install`; the browser
// never sees a token and never runs a command.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "shelf-public");
const CLI = join(HERE, "cli", "cubby.mjs");
// In the image shelf.mjs and push.sh sit in /app; in a checkout the shelf lives
// in cubby/ and the tools one directory up. CUBBY_REPO wins.
const REPO = process.env.CUBBY_REPO ?? (existsSync(join(HERE, "..", "node", "push.sh")) ? resolve(HERE, "..") : HERE);
const INSTALLED = "installed.json";
const COOKIE = "cubby_shelf";
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	// Chromium sends `Origin: null` on form POSTs when the referrer policy is
	// no-referrer, which would defeat the same-origin check; keep the origin
	// inside this origin only.
	"referrer-policy": "same-origin",
	"x-frame-options": "DENY",
	"content-security-policy":
		"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

const strip = (value) => String(value).replace(/\/+$/, "");

export function createShelf(options = {}) {
	const config = {
		port: Number(options.port ?? process.env.PORT ?? 3000),
		host: options.host ?? process.env.HOST ?? "0.0.0.0",
		dataDir: resolve(options.dataDir ?? process.env.CUBBY_SHELF_DATA ?? "/data"),
		store: strip(options.store ?? process.env.CUBBY_STORE ?? "http://cubby:3000"),
		storePublic: strip(options.storePublic ?? process.env.CUBBY_STORE_PUBLIC ?? process.env.CUBBY_STORE ?? "http://cubby:3000"),
		celldApi: strip(options.celldApi ?? process.env.CELLD_ADMIN_API ?? "http://admin.internal:8080"),
		adminToken: options.adminToken ?? process.env.ADMIN_TOKEN ?? "",
		adminHost: options.adminHost ?? process.env.ADMIN_HOST ?? "admin.internal",
		appDomain: String(options.appDomain ?? process.env.CUBBY_APP_DOMAIN ?? "localhost").replace(/^\.+/, ""),
		appScheme: options.appScheme ?? process.env.CUBBY_APP_SCHEME ?? "https",
		password: options.password ?? process.env.CUBBY_SHELF_PASSWORD ?? "",
		secret: options.secret ?? process.env.CUBBY_SHELF_SECRET ?? "",
		sessionDays: Number(options.sessionDays ?? 7),
		rateLimit: options.rateLimit !== false,
		logging: options.logging !== false,
	};
	if (!config.password) throw new Error("CUBBY_SHELF_PASSWORD is required");
	if (!config.secret) throw new Error("CUBBY_SHELF_SECRET is required");
	if (!config.adminToken) throw new Error("ADMIN_TOKEN is required");
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

	const vault = join(config.dataDir, INSTALLED);
	const readInstalled = () => {
		try {
			return JSON.parse(readFileSync(vault, "utf8"));
		} catch {
			return {};
		}
	};
	const writeInstalled = (value) => writeFileSync(vault, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });

	// --- sessions and login ---------------------------------------------------
	const sign = (value) => createHmac("sha256", config.secret).update(value).digest("base64url");
	// Cookies are statelessly signed *and* backed by this set, so logout can revoke
	// a session server-side. A signed cookie alone would remain valid after logout.
	const sessions = new Map(); // id -> expiresAt
	const newSession = () => {
		const now = Date.now();
		for (const [id, expiry] of sessions) if (expiry < now) sessions.delete(id);
		const id = randomBytes(18).toString("base64url");
		const exp = now + config.sessionDays * 24 * 60 * 60 * 1000;
		sessions.set(id, exp);
		return `${id}.${exp}.${sign(`${id}.${exp}`)}`;
	};
	const validSession = (token) => {
		if (typeof token !== "string") return false;
		const [id, exp, sig] = token.split(".");
		if (!id || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
		const a = Buffer.from(sig);
		const b = Buffer.from(sign(`${id}.${exp}`));
		if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
		const stored = sessions.get(id);
		if (!stored || stored < Date.now()) {
			sessions.delete(id);
			return false;
		}
		return true;
	};
	const sessionId = (req) => String(cookies(req)[COOKIE] ?? "").split(".")[0];
	const sameOrigin = (req) => {
		const origin = req.headers.origin;
		if (!origin) return true;
		try {
			return new URL(origin).hostname === String(req.headers.host ?? "").split(":")[0];
		} catch {
			return false;
		}
	};
	const cookies = (req) =>
		Object.fromEntries(
			String(req.headers.cookie ?? "")
				.split(";")
				.map((part) => part.trim().split("="))
				.filter(([k, v]) => k && v !== undefined),
		);
	const loggedIn = (req) => validSession(cookies(req)[COOKIE]);
	const passwordOk = (value) => {
		const a = Buffer.from(String(value));
		const b = Buffer.from(config.password);
		return a.length === b.length && timingSafeEqual(a, b);
	};
	const loginHits = new Map();
	const loginLimited = (ip) => {
		if (!config.rateLimit) return false;
		const now = Date.now();
		const hit = loginHits.get(ip);
		if (!hit || hit.reset < now) {
			loginHits.set(ip, { n: 1, reset: now + 60_000 });
			return false;
		}
		hit.n++;
		return hit.n > 8;
	};

	const secureCookie = (req) => (String(req.headers["x-forwarded-proto"] ?? "").includes("https") ? "; Secure" : "");
	const sessionCookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req)}`;
	const clearCookie = (req) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`;

	// --- helpers --------------------------------------------------------------
	function json(res, status, body, extra = {}) {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			...SECURITY_HEADERS,
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store",
			...extra,
		});
		res.end(payload);
	}
	const fail = (res, status, message) => json(res, status, { error: message });

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
		const text = await readBody(req, 64 * 1024);
		try {
			return JSON.parse(text);
		} catch {
			throw new HttpError(400, "body is not JSON");
		}
	}

	function serveStatic(req, res, pathname) {
		const map = {
			"/login": "login.html",
			"/login.js": "login.js",
			"/app.js": "app.js",
			"/style.css": "style.css",
			"/favicon.svg": "favicon.svg",
			"/fonts/fraunces-latin-wght-normal.woff2": "fonts/fraunces-latin-wght-normal.woff2",
			"/fonts/ibm-plex-mono-latin-400-normal.woff2": "fonts/ibm-plex-mono-latin-400-normal.woff2",
			"/fonts/ibm-plex-mono-latin-500-normal.woff2": "fonts/ibm-plex-mono-latin-500-normal.woff2",
		};
		if (pathname === "/" || pathname === "/index.html") {
			if (!loggedIn(req)) {
				res.writeHead(303, { location: "/login" }).end();
				return true;
			}
			map["/"] = "index.html";
			map["/index.html"] = "index.html";
		}
		const name = map[pathname];
		if (!name) return false;
		const file = resolve(join(PUBLIC_DIR, name));
		if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file)) return false;
		const body = readFileSync(file);
		res.writeHead(200, {
			...SECURITY_HEADERS,
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"content-length": body.length,
			"cache-control": "no-cache",
		});
		res.end(req.method === "HEAD" ? undefined : body);
		return true;
	}

	async function storeJson(path) {
		const res = await fetch(`${config.store}${path}`, { signal: AbortSignal.timeout(30_000) });
		const text = await res.text();
		let body = {};
		try {
			body = JSON.parse(text);
		} catch {}
		if (!res.ok) throw new HttpError(res.status, body.error || `store answered ${res.status}`);
		return body;
	}

	function adminRequest(method, path) {
		const base = new URL(config.celldApi);
		return new Promise((resolvePromise, rejectPromise) => {
			const req = httpRequest(
				{
					hostname: base.hostname,
					port: base.port || 80,
					path,
					method,
					headers: { Host: config.adminHost, authorization: `Bearer ${config.adminToken}` },
				},
				(res) => {
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
				},
			);
			req.on("error", rejectPromise);
			req.end();
		});
	}

	/** Run the same installer the CLI uses, with the shelf's node credentials. */
	function runInstall(args) {
		return new Promise((resolvePromise) => {
			const child = spawn(process.execPath, [CLI, ...args], {
				cwd: HERE,
				env: {
					...process.env,
					CUBBY_CONFIG: join(config.dataDir, "config.json"),
					CUBBY_REPO: REPO,
					CUBBY_STORE: config.store,
					CELLD_ADMIN_API: config.celldApi,
					ADMIN_TOKEN: config.adminToken,
					ADMIN_HOST: config.adminHost,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			const add = (chunk) => {
				output = (output + chunk).slice(-8000);
			};
			child.stdout.setEncoding("utf8").on("data", add);
			child.stderr.setEncoding("utf8").on("data", add);
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolvePromise({ code: 124, output: `${output}\ninstall timed out` });
			}, 180_000);
			child.on("error", (err) => {
				clearTimeout(timer);
				resolvePromise({ code: 1, output: `${output}\n${err.message}` });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolvePromise({ code: code ?? 1, output: output.trim() });
			});
		});
	}

	function clientIp(req) {
		const forwarded = String(req.headers["x-forwarded-for"] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return forwarded[forwarded.length - 1] || req.socket.remoteAddress || "?";
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
			if (pathname === "/api/health" && method === "GET") return json(res, 200, { ok: true });
			if (pathname === "/login" && method === "GET") {
				if (!serveStatic(req, res, "/login")) fail(res, 404, "not found");
				return;
			}
			if (pathname === "/login" && method === "POST") {
				if (!sameOrigin(req)) return fail(res, 403, "cross-origin login");
				if (loginLimited(clientIp(req))) return fail(res, 429, "too many attempts");
				const form = new URLSearchParams(await readBody(req, 4096));
				if (!passwordOk(form.get("password") ?? "")) {
					res.writeHead(303, { location: "/login?bad=1" }).end();
					return;
				}
				res.writeHead(303, {
					"set-cookie": sessionCookie(req, newSession(), config.sessionDays * 24 * 60 * 60),
					location: "/",
				}).end();
				return;
			}
			if (pathname === "/logout" && method === "POST") {
				if (!sameOrigin(req)) return fail(res, 403, "cross-origin logout");
				const id = sessionId(req);
				if (id) sessions.delete(id);
				res.writeHead(303, { "set-cookie": clearCookie(req), location: "/login" }).end();
				return;
			}
			if (pathname === "/" || pathname === "/login" || pathname === "/login.js" || pathname === "/app.js" || pathname === "/style.css" || pathname === "/favicon.svg") {
				if (!serveStatic(req, res, pathname)) fail(res, 404, "not found");
				return;
			}
			if (!pathname.startsWith("/api/")) {
				if (!serveStatic(req, res, pathname)) fail(res, 404, "not found");
				return;
			}
			if (!loggedIn(req)) return fail(res, 401, "sign in first");
			if (method !== "GET" && !sameOrigin(req)) return fail(res, 403, "cross-origin request");

			if (pathname === "/api/config" && method === "GET") {
				return json(res, 200, {
					store: config.storePublic,
					appDomain: config.appDomain,
					appScheme: config.appScheme,
				});
			}
			if (pathname === "/api/catalog" && method === "GET") {
				const query = url.searchParams.toString();
				return json(res, 200, await storeJson(`/api/v1/apps${query ? `?${query}` : ""}`));
			}
			if (pathname === "/api/installed" && method === "GET") {
				const entries = Object.entries(readInstalled()).map(([host, value]) => ({ host, ...value }));
				const enriched = await Promise.all(
					entries.map(async (entry) => {
						try {
							const detail = await storeJson(`/api/v1/apps/${entry.slug}`);
							const latest = detail.releases.find((r) => r.status === "published") ?? null;
							return {
								...entry,
								name: detail.app.name,
								summary: detail.app.summary,
								latest: latest?.version ?? null,
								updateAvailable: Boolean(latest && latest.version !== entry.version),
							};
						} catch {
							return { ...entry, latest: null, updateAvailable: false };
						}
					}),
				);
				return json(res, 200, { installed: enriched.sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt))) });
			}
			if (pathname.startsWith("/api/apps/") && method === "GET") {
				let slug;
				try {
					slug = decodeURIComponent(pathname.slice("/api/apps/".length));
				} catch {
					return fail(res, 400, "bad app id");
				}
				if (!/^[a-z0-9-]+$/.test(slug)) return fail(res, 400, "bad app id");
				return json(res, 200, await storeJson(`/api/v1/apps/${slug}`));
			}
			if (pathname === "/api/install" && method === "POST") {
				const body = await readJson(req);
				const slug = String(body.slug ?? "");
				const host = String(body.host ?? "").trim().toLowerCase();
				const version = body.version ? String(body.version) : null;
				if (!/^[a-z0-9-]{2,40}$/.test(slug)) return fail(res, 400, "bad app id");
				if (!HOSTNAME.test(host) || host === "admin.internal") return fail(res, 400, "enter a site hostname, e.g. celld-wichteln.example.com");
				const detail = await storeJson(`/api/v1/apps/${slug}`);
				const release = version ? detail.releases.find((r) => r.version === version) : detail.releases.find((r) => r.status === "published");
				if (!release || release.status !== "published") return fail(res, 404, "that release is not published");
				const egress = release.manifest?.egress ?? [];
				if (egress.length && !body.allowEgress) {
					return fail(res, 403, `this app wants network access to ${egress.join(", ")}; review and allow it first`);
				}
				const prior = readInstalled()[host];
				if (prior && prior.slug !== slug && !body.replace) {
					return fail(res, 409, `${host} already runs ${prior.slug}; confirm replacing it`);
				}
				const args = ["install", `${slug}@${release.version}`, "--host", host, "--yes", "--watch", "0", "--store", config.store];
				if (egress.length && body.allowEgress) args.push("--allow-egress");
				if (body.replace) args.push("--replace");
				const result = await runInstall(args);
				if (result.code !== 0) return fail(res, 422, result.output || "install failed");
				return json(res, 200, { ok: true, output: result.output, installed: readInstalled()[host] ?? null });
			}
			if (pathname === "/api/remove" && method === "POST") {
				const body = await readJson(req);
				const host = String(body.host ?? "").trim().toLowerCase();
				if (!HOSTNAME.test(host)) return fail(res, 400, "bad host");
				if (body.confirm !== host) return fail(res, 400, "confirmation does not match the hostname");
				const result = await adminRequest(
					"DELETE",
					`/__admin/site?id=${encodeURIComponent(host)}&confirm=${encodeURIComponent(host)}`,
				);
				if (result.status >= 300 && result.status !== 404) {
					let message = result.body;
					try {
						message = JSON.parse(result.body).error ?? message;
					} catch {}
					return fail(res, result.status, message || "could not remove the site");
				}
				const all = readInstalled();
				delete all[host];
				writeInstalled(all);
				return json(res, 200, { ok: true });
			}
			return fail(res, 404, "no such endpoint");
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) console.error("shelf: request failed", err);
			if (!res.headersSent) fail(res, status, status === 500 ? "internal error" : err.message);
			else res.destroy();
		} finally {
			if (config.logging && pathname !== "/api/health") console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
		}
	});
	server.requestTimeout = 200_000; // installs include a deploy check
	server.headersTimeout = 15_000;
	server.on("clientError", (_err, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});

	return {
		config,
		server,
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
			await new Promise((resolvePromise) => server.close(resolvePromise));
		},
	};
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const shelf = createShelf();
	const address = await shelf.listen();
	const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
	console.log(`cubby shelf: http://${where} (store ${shelf.config.store}, node ${shelf.config.celldApi})`);
	const stop = async (signal) => {
		console.log(`cubby shelf: ${signal}, shutting down`);
		await shelf.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	// A malformed request must not take the whole service down. Individual
	// handlers still catch and answer; this is the last-resort availability net.
	process.on("unhandledRejection", (reason) => console.error("cubby: unhandled rejection", reason));
}
