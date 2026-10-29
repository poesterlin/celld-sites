// Test fixtures for Hamstr: a mock OIDC provider (real RS256 ID tokens, PKCE
// checked), a mock celld node, and an HTTP client that sets Host and keeps
// cookies per "browser".
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

/** OIDC provider. `users` maps a login hint to claims; `nextUser` picks who
 *  "signs in" at the next /authorize. `tamper` breaks the next ID token. */
export async function mockIdp({ clientId = "hamstr-test", clientSecret = "s3cret" } = {}) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
	const codes = new Map();
	const idp = { clientId, clientSecret, nextUser: null, tamper: null, issuer: "", tokenCalls: 0 };
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://localhost");
		const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (url.pathname === "/.well-known/openid-configuration") {
			return send(200, {
				issuer: idp.issuer,
				authorization_endpoint: `${idp.issuer}/authorize`,
				token_endpoint: `${idp.issuer}/token`,
				userinfo_endpoint: `${idp.issuer}/userinfo`,
				jwks_uri: `${idp.issuer}/jwks`,
			});
		}
		if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
		if (url.pathname === "/authorize") {
			// Real IdPs show a login page; here the test chose the user up front.
			const code = randomBytes(12).toString("hex");
			codes.set(code, {
				user: idp.nextUser,
				nonce: url.searchParams.get("nonce"),
				challenge: url.searchParams.get("code_challenge"),
				redirect: url.searchParams.get("redirect_uri"),
				client: url.searchParams.get("client_id"),
			});
			const back = new URL(url.searchParams.get("redirect_uri"));
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state"));
			return res.writeHead(302, { location: back.toString() }).end();
		}
		if (url.pathname === "/token" && req.method === "POST") {
			idp.tokenCalls++;
			let body = "";
			for await (const chunk of req) body += chunk;
			const form = new URLSearchParams(body);
			const auth = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
			if (auth !== `${clientId}:${clientSecret}`) return send(401, { error: "invalid_client" });
			const entry = codes.get(form.get("code"));
			codes.delete(form.get("code"));
			if (!entry) return send(400, { error: "invalid_grant" });
			const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
			if (challenge !== entry.challenge || form.get("redirect_uri") !== entry.redirect) return send(400, { error: "invalid_grant" });
			const now = Math.floor(Date.now() / 1000);
			const claims = { iss: idp.issuer, aud: clientId, iat: now, exp: now + 300, nonce: entry.nonce, ...entry.user };
			const t = idp.tamper;
			idp.tamper = null;
			if (t === "nonce") claims.nonce = "other";
			if (t === "aud") claims.aud = "someone-else";
			if (t === "expired") claims.exp = now - 3600;
			const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
			const payload = b64(claims);
			let sig = sign("sha256", Buffer.from(`${head}.${payload}`), privateKey).toString("base64url");
			if (t === "signature") sig = sig.slice(0, -4) + (sig.endsWith("AAAA") ? "BBBB" : "AAAA");
			return send(200, { access_token: `at-${entry.user.sub}`, token_type: "Bearer", id_token: `${head}.${payload}.${sig}` });
		}
		if (url.pathname === "/userinfo") {
			const sub = String(req.headers.authorization ?? "").replace(/^Bearer at-/, "");
			return send(200, { sub, picture: "https://example.com/p.png" });
		}
		send(404, { error: "not found" });
	});
	const port = await listen(server);
	idp.issuer = `http://127.0.0.1:${port}`;
	idp.close = () => new Promise((r) => server.close(r));
	return idp;
}

/** A celld stand-in: records admin calls, answers them, and echoes grain requests. */
export async function mockCelld({ adminToken = "admin-token", proxyToken = "proxy-token" } = {}) {
	const node = { adminToken, proxyToken, calls: [], sites: new Map(), failCheck: false };
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		const url = new URL(req.url, "http://localhost");
		const send = (status, value, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
		if (req.headers.host === "admin.internal") {
			if (req.headers.authorization !== `Bearer ${adminToken}`) return send(401, { error: "token" });
			const path = url.pathname.replace(/^\/__admin/, "");
			node.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body: body.toString() });
			if (path === "/blobs/missing") return send(200, { missing: JSON.parse(body.toString()) });
			if (path === "/check") return send(200, node.failCheck ? { ok: false, status: 500, path: "/", error: "boom" } : { ok: true, status: 200, path: "/" });
			if (path === "/activate") node.sites.set(url.searchParams.get("host"), url.searchParams.get("version"));
			if (path === "/site" && req.method === "DELETE") {
				const id = url.searchParams.get("id");
				if (!node.sites.has(id)) return send(404, { error: "no site" });
				node.sites.delete(id);
			}
			return send(200, { ok: true });
		}
		// A grain request through the proxy.
		if (req.headers["x-celld-proxy-token"] !== proxyToken || !node.sites.has(req.headers.host)) return send(404, { error: "no site" });
		if (url.pathname === "/setcookie") {
			return res
				.writeHead(200, {
					"set-cookie": ["app=1; Path=/", "wide=1; Domain=example.dev; Path=/", "hamstr_grain=evil; Path=/"],
					"content-security-policy": "default-src 'self'",
				})
				.end("ok");
		}
		send(200, { host: req.headers.host, method: req.method, path: req.url, headers: req.headers, body: body.toString() });
	});
	node.port = await listen(server);
	node.api = `http://127.0.0.1:${node.port}`;
	node.close = () => new Promise((r) => server.close(r));
	return node;
}

/** A browser: one cookie jar, explicit Host header. */
export class Browser {
	constructor(port) {
		this.port = port;
		this.jar = new Map(); // host -> Map(name -> value)
	}
	cookieHeader(host) {
		const jar = this.jar.get(host);
		return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
	}
	request(method, path, { host, headers = {}, body, json } = {}) {
		const data = json !== undefined ? Buffer.from(JSON.stringify(json)) : body === undefined ? undefined : Buffer.from(body);
		const cookie = this.cookieHeader(host);
		return new Promise((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: this.port,
					method,
					path,
					headers: {
						host,
						...(cookie && { cookie }),
						...(json !== undefined && { "content-type": "application/json" }),
						...(data && { "content-length": data.length }),
						...headers,
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						for (const line of [res.headers["set-cookie"] ?? []].flat()) {
							const [pair, ...attrs] = line.split(";");
							const i = pair.indexOf("=");
							const name = pair.slice(0, i).trim();
							const value = pair.slice(i + 1).trim();
							if (!this.jar.has(host)) this.jar.set(host, new Map());
							if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "") this.jar.get(host).delete(name);
							else this.jar.get(host).set(name, value);
						}
						const text = Buffer.concat(chunks).toString("utf8");
						let parsed = null;
						try {
							parsed = JSON.parse(text);
						} catch {}
						resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
					});
				},
			);
			req.on("error", reject);
			if (data) req.write(data);
			req.end();
		});
	}
}
