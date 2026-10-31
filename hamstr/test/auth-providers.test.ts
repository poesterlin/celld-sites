import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider, profileFromClaims } from "../lib/auth/providers.ts";
import { signToken, safeNext, verifyToken } from "../lib/auth/token.ts";
import { mockIssuer } from "./auth-helpers.ts";

const now = () => Math.floor(Date.now() / 1000);

test("tokens round-trip and refuse tampering, other types, other hosts and expiry", () => {
	const key = "k".repeat(32);
	const token = signToken(key, { typ: "site", aud: "a.example.com", exp: now() + 60, sub: "u1" });
	assert.equal(verifyToken(key, token, { typ: "site", aud: "a.example.com" })?.sub, "u1");
	assert.equal(verifyToken(key, token, { typ: "handoff", aud: "a.example.com" }), null, "type");
	assert.equal(verifyToken(key, token, { typ: "site", aud: "b.example.com" }), null, "audience");
	assert.equal(verifyToken("x".repeat(32), token, { typ: "site" }), null, "key");
	assert.equal(verifyToken(key, token + "A", { typ: "site" }), null, "signature");
	const [body, sig] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ typ: "site", aud: "a.example.com", exp: now() + 999, sub: "root" })).toString("base64url");
	assert.equal(verifyToken(key, `${forged}.${sig}`, { typ: "site" }), null, "payload swapped");
	assert.ok(body);
	const old = signToken(key, { typ: "site", aud: "a", exp: now() - 1 });
	assert.equal(verifyToken(key, old, { typ: "site" }), null, "expired");
	for (const junk of [undefined, 5, "", "a", "a.b.c", "x".repeat(5000)]) assert.equal(verifyToken(key, junk, { typ: "site" }), null);
});

test("safeNext only lets same-host paths through", () => {
	assert.equal(safeNext("/a/b?c=d"), "/a/b?c=d");
	for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a\nb", undefined, 3]) assert.equal(safeNext(bad), "/");
});

test("an OIDC provider signs a person in with PKCE and checks state, nonce and the ID token", async () => {
	const idp = await mockIssuer();
	try {
		const provider = createProvider({ kind: "oidc", issuer: idp.issuer, clientId: "c", clientSecret: "s" }, "https://auth.example.com/callback/x");
		assert.equal(await provider.check(), idp.issuer);
		const url = new URL(await provider.start({ state: "st", nonce: "n1", challenge: "ch" }));
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		assert.equal(url.searchParams.get("redirect_uri"), "https://auth.example.com/callback/x");
		idp.nonce = "n1";
		const back = new URLSearchParams({ code: "c", state: "st" });
		const profile = await provider.finish({ params: back, state: "st", verifier: "v".repeat(43), nonce: "n1" });
		assert.deepEqual(profile, { subject: "u1", email: "a@example.com", emailVerified: true, name: "Ada", username: null, picture: null });
		await assert.rejects(provider.finish({ params: back, state: "st", verifier: "v".repeat(43), nonce: "other" }), /did not check out/);
		await assert.rejects(provider.finish({ params: back, state: "other", verifier: "v".repeat(43), nonce: "n1" }), /did not check out/);
		// The ID token comes straight from the token endpoint over TLS, so (as OIDC Core
		// 3.1.3.7 allows) openid-client trusts the channel rather than the signature.
	} finally {
		await idp.close();
	}
});

test("a plain-http issuer is refused unless it is on this machine", async () => {
	const provider = createProvider({ kind: "oidc", issuer: "http://idp.example.com", clientId: "c", clientSecret: "s" }, "https://auth.example.com/callback/x");
	await assert.rejects(provider.check(), /could not be reached/);
});

test("profileFromClaims falls back sensibly and distrusts an unverified email", () => {
	assert.equal(profileFromClaims({ sub: "1", preferred_username: "ada" }).name, "ada");
	assert.equal(profileFromClaims({ sub: "1", email: "x@y.z" }).name, "x");
	assert.equal(profileFromClaims({ sub: "1", email: "x@y.z", email_verified: false }).emailVerified, false);
	assert.equal(profileFromClaims({ sub: "1" }).name, "Someone");
});

