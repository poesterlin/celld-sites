// Sign-in tests: the router's cookie check, header injection and policy admin API,
// against a local celld dev node. The sign-in service (Hamstr) is played by this file (it signs
// handoff tokens with the shared key).
// Run: node --test tests/signin.test.ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Node } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "celld-signin-"));
const node = new Node(8791);
const nokey = new Node(8792);
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (key: string, payload: object) => {
	const body = b64(JSON.stringify(payload));
	return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
};
const now = () => Math.floor(Date.now() / 1000);
const handoff = (host: string, extra: object = {}, key = node.authKey) =>
	sign(key, { typ: "handoff", aud: host, jti: Math.random().toString(36).slice(2), exp: now() + 30, sub: "u1", name: "Åsa Lind", email: "asa@example.com", groups: ["fam ily", "kids"], role: "member", ...extra });
const get = (n: Node, host: string, path: string, headers: Record<string, string> = {}) => n.request("GET", path, { host, headers });
const cookieOf = (r) => String(r.headers["set-cookie"]).split(";")[0];

const worker = `export default { async fetch(request) {
	const h = {};
	for (const [k, v] of request.headers) if (k.startsWith("x-celld-user-") || k === "cookie") h[k] = v;
	return Response.json(h);
} };\n`;

const shared: string[] = [];
const site = (auth?: string, extra: object = {}) =>
	writeFileSync(join(dir, "celld.json"), JSON.stringify({ worker: "worker.js", check: false, ...(auth && { auth }), ...extra }));

before(async () => {
	nokey.authKey = "";
	await node.start();
	await nokey.start();
	// Every site runs the same build on purpose: the mode belongs to the site, so
	// deploying the build elsewhere without `auth` must not open gated.test.
	writeFileSync(join(dir, "worker.js"), worker);
	site("required");
	shared.push(node.deploy(dir, "gated.test").version);
	nokey.deploy(dir, "gated.test");
	site("optional");
	shared.push(node.deploy(dir, "open.test").version);
	site();
	shared.push(node.deploy(dir, "plain.test").version);
});

after(async () => {
	await node.stop();
	await nokey.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("sign-in: gating", () => {
	it("redirects a navigation to the sign-in service with a signed request", async () => {
		const r = await get(node, "gated.test", "/page?x=1");
		assert.equal(r.status, 302);
		const loc = new URL(String(r.headers.location));
		assert.equal(loc.origin, "https://auth.test");
		assert.equal(loc.pathname, "/authorize");
		const [body] = loc.searchParams.get("req")!.split(".");
		const req = JSON.parse(Buffer.from(body, "base64url").toString());
		assert.equal(req.typ, "authreq");
		assert.equal(req.aud, "gated.test");
		assert.equal(req.next, "/page?x=1");
		assert.equal(sign(node.authKey, req), loc.searchParams.get("req"));
	});
	it("answers 401 to non-navigations", async () => {
		assert.equal((await get(node, "gated.test", "/api", { accept: "application/json" })).status, 401);
		assert.equal((await node.request("POST", "/x", { host: "gated.test" })).status, 401);
	});
	it("leaves sites without auth and public sites open", async () => {
		assert.equal((await get(node, "plain.test", "/")).status, 200);
		const open = await get(node, "open.test", "/");
		assert.equal(open.status, 200);
		assert.equal(Object.keys(open.json()).length, 0);
	});
	it("fails closed when the node has no key", async () => {
		assert.equal((await get(nokey, "gated.test", "/")).status, 503);
	});
});

describe("sign-in: handoff and cookie", () => {
	it("trades a handoff for a host-only cookie and redirects to next", async () => {
		const r = await get(node, "gated.test", `/.celld/auth/callback?token=${handoff("gated.test")}&next=/inside`);
		assert.equal(r.status, 303);
		assert.equal(r.headers.location, "/inside");
		const line = String(r.headers["set-cookie"]);
		assert.match(line, /^celld_auth=/);
		assert.match(line, /HttpOnly/i);
		assert.match(line, /SameSite=Lax/i);
		assert.doesNotMatch(line, /Domain=/i);
	});
	it("injects the user, strips the cookie and forged headers", async () => {
		const c = cookieOf(await get(node, "gated.test", `/.celld/auth/callback?token=${handoff("gated.test")}`));
		const r = await get(node, "gated.test", "/", { cookie: `${c}; theme=dark`, "x-celld-user-id": "forged", "x-celld-user-role": "owner" });
		assert.equal(r.status, 200);
		const h = r.json();
		assert.equal(h["x-celld-user-id"], "u1");
		assert.equal(decodeURIComponent(h["x-celld-user-name"]), "Åsa Lind");
		assert.equal(decodeURIComponent(h["x-celld-user-email"]), "asa@example.com");
		assert.equal(h["x-celld-user-groups"], "fam%20ily,kids");
		assert.equal(h["x-celld-user-role"], "member");
		assert.equal(h.cookie, "theme=dark");
	});
	it("strips forged user headers on an open site without a session", async () => {
		const r = await get(node, "open.test", "/", { "x-celld-user-id": "forged" });
		assert.deepEqual(r.json(), {});
	});
	it("rejects replayed, expired, wrong-audience, wrong-type and wrongly-signed tokens", async () => {
		const once = handoff("gated.test");
		assert.equal((await get(node, "gated.test", `/.celld/auth/callback?token=${once}`)).status, 303);
		assert.equal((await get(node, "gated.test", `/.celld/auth/callback?token=${once}`)).status, 400);
		const bad = [
			handoff("gated.test", { exp: now() - 5 }),
			handoff("other.test"),
			handoff("gated.test", { typ: "site" }),
			handoff("gated.test", {}, "wrong-key"),
			"garbage",
		];
		for (const t of bad) assert.equal((await get(node, "gated.test", `/.celld/auth/callback?token=${t}`)).status, 400, t.slice(0, 20));
	});
	it("does not accept another host's cookie", async () => {
		const c = cookieOf(await get(node, "gated.test", `/.celld/auth/callback?token=${handoff("gated.test")}`));
		assert.equal((await get(node, "open.test", "/.celld/auth/me", { cookie: c })).json().user, null);
		assert.equal((await get(node, "gated.test", "/", { cookie: c })).status, 200);
	});
	it("does not follow an off-site next", async () => {
		for (const next of ["//evil.test", "https://evil.test", "/\\evil.test"]) {
			const r = await get(node, "gated.test", `/.celld/auth/callback?token=${handoff("gated.test")}&next=${encodeURIComponent(next)}`);
			assert.equal(r.headers.location, "/", next);
		}
	});
});

describe("sign-in: me and logout", () => {
	it("reports the user and mode", async () => {
		const c = cookieOf(await get(node, "gated.test", `/.celld/auth/callback?token=${handoff("gated.test")}`));
		const me = (await get(node, "gated.test", "/.celld/auth/me", { cookie: c })).json();
		assert.equal(me.mode, "required");
		assert.equal(me.user.id, "u1");
		const anon = (await get(node, "open.test", "/.celld/auth/me")).json();
		assert.deepEqual(anon, { user: null, mode: "optional" });
	});
	it("logout clears the cookie and goes to the sign-in service", async () => {
		const r = await get(node, "gated.test", "/.celld/auth/logout");
		assert.equal(r.status, 303);
		assert.match(String(r.headers.location), /^https:\/\/auth\.test\/logout/);
		assert.match(String(r.headers["set-cookie"]), /Max-Age=0/i);
	});
});

describe("sign-in: policy admin API", () => {
	it("reports declared policy and lets an override win", async () => {
		const g = (await node.admin("GET", "/auth?host=gated.test")).json();
		assert.equal(g.mode, "required");
		assert.equal(g.declared, "required");
		assert.equal(g.override, null);
		assert.equal((await node.admin("PUT", "/auth?host=gated.test", { body: { mode: "optional" } })).status, 200);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await get(node, "gated.test", "/")).status, 200);
		assert.equal((await node.admin("DELETE", "/auth?host=gated.test")).status, 200);
		assert.equal((await get(node, "gated.test", "/")).status, 302);
	});
	it("validates input and needs the admin token", async () => {
		assert.equal((await node.admin("PUT", "/auth?host=gated.test", { body: { mode: "nope" } })).status, 400);
		assert.equal((await node.admin("GET", "/auth", { token: "wrong" })).status, 403);
		const all = (await node.admin("GET", "/auth")).json();
		assert.ok(all.sites.length >= 3);
	});
});

describe("sign-in: celld.json validation", () => {
	it("rejects a bad auth declaration at pack time", () => {
		for (const auth of ["nobody", true, { access: "everyone" }]) {
			writeFileSync(join(dir, "celld.json"), JSON.stringify({ worker: "worker.js", check: false, auth }));
			assert.throws(() => node.tryDeploy(dir, "bad.test"), /auth must be/, JSON.stringify(auth));
		}
	});
});

describe("sign-in: the mode belongs to the site", () => {
	it("one build on several sites keeps each site's own mode", async () => {
		assert.equal((await get(node, "gated.test", "/")).status, 302);
		assert.equal((await get(node, "plain.test", "/")).status, 200);
		assert.equal(new Set(shared).size, 1, "the test relies on one shared build");
	});
	it("a deploy without auth drops the declared mode; rolling back restores it", async () => {
		site("required", { check: "/v1" });
		const first = node.deploy(dir, "roll.test");
		assert.equal((await get(node, "roll.test", "/")).status, 302);
		writeFileSync(join(dir, "worker.js"), worker + "globalThis.v2 = 1;\n");
		site();
		node.deploy(dir, "roll.test");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal((await get(node, "roll.test", "/")).status, 200);
		assert.equal((await node.admin("POST", `/activate?host=roll.test&version=${first.version}`)).status, 200);
		assert.equal((await get(node, "roll.test", "/")).status, 302);
		writeFileSync(join(dir, "worker.js"), worker);
	});
	it("an override is refused for a site that does not exist", async () => {
		assert.equal((await node.admin("PUT", "/auth?host=nowhere.test", { body: { mode: "required" } })).status, 404);
	});
	it("encodes a non-Latin-1 email instead of failing the request", async () => {
		const handoffEmail = handoff("gated.test", { email: "иван@пример.рф" });
		const c = cookieOf(await get(node, "gated.test", `/.celld/auth/callback?token=${handoffEmail}`));
		const r = await get(node, "gated.test", "/", { cookie: c });
		assert.equal(r.status, 200);
		assert.equal(decodeURIComponent(r.json()["x-celld-user-email"]), "иван@пример.рф");
	});
});
