// A software authenticator and a mock OIDC provider for the auth service's tests.
import { createHash, createSign, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

const sha256 = (d: Buffer | string) => createHash("sha256").update(d).digest();

// Just enough CBOR to build an attestation object.
export function cbor(value: any): Buffer {
	const head = (major: number, n: number) => {
		if (n < 24) return Buffer.from([(major << 5) | n]);
		if (n < 256) return Buffer.from([(major << 5) | 24, n]);
		return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
	};
	if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
	if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
	if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
	throw new Error("cbor: unsupported");
}

export function authenticator(rpId: string, origin: string) {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk: any = publicKey.export({ format: "jwk" });
	const credentialId = randomBytes(16);
	let counter = 0;
	const clientData = (type: string, challenge: string, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o }));
	return {
		credentialId: credentialId.toString("base64url"),
		create(challenge: string, o = origin) {
			const cose = cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
			const counterBuf = Buffer.alloc(4);
			const idLength = Buffer.alloc(2);
			idLength.writeUInt16BE(credentialId.length);
			const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), counterBuf, Buffer.alloc(16), idLength, credentialId, cose]);
			return {
				clientDataJSON: clientData("webauthn.create", challenge, o).toString("base64url"),
				attestationObject: cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])).toString("base64url"),
			};
		},
		get(challenge: string, { o = origin, rp = rpId, count = ++counter }: { o?: string; rp?: string; count?: number } = {}) {
			const counterBuf = Buffer.alloc(4);
			counterBuf.writeUInt32BE(count);
			const authData = Buffer.concat([sha256(rp), Buffer.from([0x05]), counterBuf]);
			const cd = clientData("webauthn.get", challenge, o);
			return {
				clientDataJSON: cd.toString("base64url"),
				authenticatorData: authData.toString("base64url"),
				signature: sign("sha256", Buffer.concat([authData, sha256(cd)]), privateKey).toString("base64url"),
			};
		},
	};
}

/** The authenticator's answers in the JSON shape browsers (and SimpleWebAuthn) use. */
export const asJSON = (id: string, response: Record<string, string>) => ({ id, rawId: id, type: "public-key", response, clientExtensionResults: {} });

export async function listen(server: any): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

/** An OIDC issuer with real RS256 ID tokens. `claims` is who signs in next. */
export async function mockIssuer(clientId = "c", clientSecret = "s") {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
	const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
	const state: any = { issuer: "", claims: { sub: "u1", email: "A@Example.com", name: "Ada" }, nonce: "", challenge: "", tamper: false };
	const server = createServer((req, res) => {
		const url = new URL(req.url!, "http://x");
		const send = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
		if (url.pathname === "/.well-known/openid-configuration") {
			return send(200, { issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`, jwks_uri: `${state.issuer}/jwks` });
		}
		if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
		if (url.pathname === "/token") {
			const signer = createSign("RSA-SHA256");
			const head = b64({ alg: "RS256", kid: "k1" });
			const now = Math.floor(Date.now() / 1000);
			const body = b64({ iss: state.issuer, aud: clientId, iat: now, exp: now + 300, nonce: state.nonce, ...state.claims });
			signer.update(`${head}.${body}`);
			const sig = signer.sign(privateKey).toString("base64url");
			return send(200, { id_token: `${head}.${body}.${state.tamper ? "AAAA" : sig}`, access_token: "at", token_type: "Bearer" });
		}
		send(404, {});
	});
	const port = await listen(server);
	state.issuer = `http://127.0.0.1:${port}`;
	state.clientId = clientId;
	state.clientSecret = clientSecret;
	state.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
	return state;
}
