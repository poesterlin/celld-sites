// Minimal OpenID Connect client for Hamstr's sign-in (authorization code flow
// with PKCE, state and nonce). Built for tsidp, but nothing here is specific to
// it: discovery, a confidential client, RS256/ES256 ID tokens checked against
// the issuer's JWKS.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export class OidcError extends Error {}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (text) => Buffer.from(text, "base64url");

export function pkce() {
	const verifier = b64url(randomBytes(32));
	return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function createOidc({ issuer, clientId, clientSecret, redirectUri, timeoutMs = 10_000 }) {
	const base = String(issuer ?? "").replace(/\/+$/, "");
	let discovery = null;
	let discoveredAt = 0;
	let jwks = null;
	let jwksAt = 0;

	async function getJson(url, init = {}) {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		const text = await res.text();
		let body = null;
		try {
			body = JSON.parse(text);
		} catch {}
		if (!res.ok) throw new OidcError(`${new URL(url).pathname} answered ${res.status}${body?.error ? `: ${body.error}` : ""}`);
		if (!body || typeof body !== "object") throw new OidcError(`${new URL(url).pathname} did not answer JSON`);
		return body;
	}

	async function discover() {
		if (discovery && Date.now() - discoveredAt < 60 * 60 * 1000) return discovery;
		const doc = await getJson(`${base}/.well-known/openid-configuration`);
		if (doc.issuer !== base) throw new OidcError(`issuer mismatch: expected ${base}, discovery says ${doc.issuer}`);
		for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
			if (typeof doc[key] !== "string") throw new OidcError(`discovery has no ${key}`);
		}
		discovery = doc;
		discoveredAt = Date.now();
		return doc;
	}

	async function keys(force = false) {
		if (!force && jwks && Date.now() - jwksAt < 10 * 60 * 1000) return jwks;
		const doc = await discover();
		const body = await getJson(doc.jwks_uri);
		if (!Array.isArray(body.keys)) throw new OidcError("JWKS has no keys");
		jwks = body.keys;
		jwksAt = Date.now();
		return jwks;
	}

	async function authorizationUrl({ state, nonce, challenge }) {
		const doc = await discover();
		const url = new URL(doc.authorization_endpoint);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: "openid profile email",
			state,
			nonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		return url.toString();
	}

	async function verifyIdToken(token, nonce) {
		const parts = String(token ?? "").split(".");
		if (parts.length !== 3) throw new OidcError("the ID token is malformed");
		let header;
		let claims;
		try {
			header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
			claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));
		} catch {
			throw new OidcError("the ID token is malformed");
		}
		const algs = { RS256: "sha256", ES256: "sha256" };
		if (!algs[header.alg]) throw new OidcError(`unsupported ID token algorithm ${header.alg}`);
		const pick = (list) => list.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === "sig"));
		let jwk = pick(await keys());
		if (!jwk) jwk = pick(await keys(true)); // the issuer rotated its keys
		if (!jwk) throw new OidcError("no signing key matches the ID token");
		const key = createPublicKey({ key: jwk, format: "jwk" });
		const signature = fromB64url(parts[2]);
		const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
		const ok =
			header.alg === "ES256"
				? verify(algs[header.alg], signed, { key, dsaEncoding: "ieee-p1363" }, signature)
				: verify(algs[header.alg], signed, key, signature);
		if (!ok) throw new OidcError("the ID token signature is invalid");
		const now = Math.floor(Date.now() / 1000);
		if (claims.iss !== base) throw new OidcError("the ID token is from another issuer");
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(clientId)) throw new OidcError("the ID token is for another client");
		if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new OidcError("the ID token has expired");
		if (claims.nonce !== nonce) throw new OidcError("the ID token nonce does not match this sign-in");
		if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("the ID token has no subject");
		return claims;
	}

	/** Exchange the code, verify the ID token, and merge userinfo claims. */
	async function finish({ code, verifier, nonce }) {
		const doc = await discover();
		const tokens = await getJson(doc.token_endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
				authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
			},
			body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
		});
		const claims = await verifyIdToken(tokens.id_token, nonce);
		let info: any = {};
		if (doc.userinfo_endpoint && typeof tokens.access_token === "string") {
			try {
				info = await getJson(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } });
				if (info.sub !== claims.sub) info = {}; // never mix two identities
			} catch {
				info = {};
			}
		}
		return { ...info, ...claims };
	}

	return { discover, authorizationUrl, finish, verifyIdToken };
}
