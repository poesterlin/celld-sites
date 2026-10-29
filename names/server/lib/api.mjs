// The HTTP API installs talk to. Every route but /v1/register needs the
// install's token, either as "Authorization: Bearer <token>" or as Basic auth
// with the id as user and the token as password (what lego's httpreq DNS
// provider sends).
//
//   POST   /v1/register                 → 201 { id, hostname, token }
//   GET    /v1/install                  → { id, hostname, ipv4, ipv6, lastSeen }
//   PUT    /v1/address  { ipv4, ipv6 }  → the install, as above
//   POST   /v1/present  { fqdn, value } → 200   (lego httpreq)
//   POST   /v1/cleanup  { fqdn, value } → 200   (lego httpreq)
//   DELETE /v1/install                  → 204
//   GET    /healthz                     → 200
import { isIPv4, isIPv6 } from "node:net";
import { isPrivateIPv4, isPrivateIPv6 } from "./ip.mjs";

const MAX_BODY = 4096;
// ACME key authorizations are base64url SHA-256 digests (43 characters).
const CHALLENGE_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function send(res, status, body) {
	const text = body === undefined ? "" : JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw new HttpError(413, "body too large");
		chunks.push(chunk);
	}
	if (!size) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
	} catch {}
	throw new HttpError(400, "expected a JSON object");
}

function tokenOf(req) {
	const header = req.headers.authorization ?? "";
	const [scheme, rest] = header.split(" ", 2);
	if (/^bearer$/i.test(scheme)) return rest?.trim();
	if (/^basic$/i.test(scheme)) {
		const decoded = Buffer.from(rest ?? "", "base64").toString("utf8");
		const colon = decoded.indexOf(":");
		const user = decoded.slice(0, colon);
		const token = decoded.slice(colon + 1);
		// The user name must be the id the token belongs to.
		if (colon > 0 && token.startsWith(`${user}.`)) return token;
	}
	return null;
}

// Fixed-window counter per client address; enough to stop a loop from
// registering thousands of names.
function rateLimiter(perHour) {
	const windows = new Map();
	return (key) => {
		const hour = Math.floor(Date.now() / 3_600_000);
		const entry = windows.get(key);
		if (!entry || entry.hour !== hour) {
			if (windows.size > 10_000) windows.clear();
			windows.set(key, { hour, count: 1 });
			return true;
		}
		return ++entry.count <= perHour;
	};
}

export function createApi({ config, store }) {
	const allowRegister = rateLimiter(config.registerPerHour);
	const hostname = (id) => `${id}.${config.zone}`;
	const view = (row) => ({
		id: row.id,
		hostname: hostname(row.id),
		ipv4: row.ipv4 ?? null,
		ipv6: row.ipv6 ?? null,
		lastSeen: new Date(row.last_seen * 1000).toISOString(),
	});

	function clientAddress(req) {
		if (config.trustProxy) {
			const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"]?.split(",")[0];
			if (forwarded) return String(forwarded).trim();
		}
		return req.socket.remoteAddress ?? "unknown";
	}

	function authenticate(req) {
		const install = store.authenticate(tokenOf(req));
		if (!install) throw new HttpError(401, "missing or invalid token");
		return install;
	}

	function checkAddress(value, isFamily, isPrivate, label) {
		if (value === undefined || value === null || value === "") return null;
		if (typeof value !== "string" || !isFamily(value)) throw new HttpError(400, `${label} is not a valid address`);
		if (!config.allowPublicAddresses && !isPrivate(value))
			throw new HttpError(422, `${label} must be a private or Tailscale address`);
		return value;
	}

	// lego sends "_acme-challenge.<id>.<zone>." with a trailing dot.
	function checkChallenge(install, body) {
		const name = String(body.fqdn ?? "").toLowerCase().replace(/\.$/, "");
		if (name !== `_acme-challenge.${hostname(install.id)}`)
			throw new HttpError(403, `this token may only publish _acme-challenge.${hostname(install.id)}`);
		if (typeof body.value !== "string" || !CHALLENGE_VALUE.test(body.value))
			throw new HttpError(400, "value must be an ACME key authorization digest");
		return body.value;
	}

	const routes = {
		"GET /healthz": async () => ({ status: 200, body: { ok: true } }),

		"POST /v1/register": async (req) => {
			if (!allowRegister(clientAddress(req))) throw new HttpError(429, "too many registrations, try again later");
			const { id, token } = store.register();
			console.log(`names: registered ${id}`);
			return { status: 201, body: { id, hostname: hostname(id), token } };
		},

		"GET /v1/install": async (req) => ({ status: 200, body: view(authenticate(req)) }),

		"PUT /v1/address": async (req) => {
			const install = authenticate(req);
			const body = await readJson(req);
			const ipv4 = checkAddress(body.ipv4, isIPv4, isPrivateIPv4, "ipv4");
			const ipv6 = checkAddress(body.ipv6, isIPv6, isPrivateIPv6, "ipv6");
			if (!ipv4 && !ipv6) throw new HttpError(400, "give ipv4, ipv6 or both");
			store.setAddress(install.id, ipv4, ipv6);
			return { status: 200, body: view(store.get(install.id)) };
		},

		"POST /v1/present": async (req) => {
			const install = authenticate(req);
			const value = checkChallenge(install, await readJson(req));
			if (store.challengeCount(install.id) >= config.maxChallenges && !store.challenges(install.id).includes(value))
				throw new HttpError(429, "too many challenge values at once");
			store.addChallenge(install.id, value, config.challengeTtl);
			return { status: 200, body: { ok: true } };
		},

		"POST /v1/cleanup": async (req) => {
			const install = authenticate(req);
			store.removeChallenge(install.id, checkChallenge(install, await readJson(req)));
			return { status: 200, body: { ok: true } };
		},

		"DELETE /v1/install": async (req) => {
			const install = authenticate(req);
			store.remove(install.id);
			console.log(`names: released ${install.id}`);
			return { status: 204 };
		},
	};

	return async function handle(req, res) {
		const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";
		const route = routes[`${req.method} ${path}`];
		try {
			if (!route) throw new HttpError(404, "not found");
			const { status, body } = await route(req);
			send(res, status, body);
		} catch (err) {
			if (!(err instanceof HttpError)) console.error(`names: ${req.method} ${path}: ${err.stack}`);
			send(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : "internal error" });
		}
	};
}
