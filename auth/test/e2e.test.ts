// Runs the built service against a mock OIDC issuer and walks a whole sign-in the
// way a browser does: router redirect -> login -> provider -> callback -> handoff.
// Needs `npm run build` first (npm test does it).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { signToken, verifyToken } from "../lib/token.ts";
import { mockIssuer } from "./helpers.ts";

const KEY = "e".repeat(40);
const PORT = 8812;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "auth-e2e-"));
let idp: any;
let proc: ReturnType<typeof spawn>;

/** A browser's cookie jar and redirect-following, just enough. */
function browser() {
	const jar = new Map<string, string>();
	const go = async (path: string, init: RequestInit & { follow?: boolean } = {}): Promise<Response> => {
		const res = await fetch(path.startsWith("http") ? path : ORIGIN + path, {
			redirect: "manual",
			...init,
			headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "sec-fetch-site": "same-origin", ...(init.headers as any) },
		});
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const eq = pair.indexOf("=");
			if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(pair.slice(0, eq));
			else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
		return res;
	};
	return { go, jar };
}

before(async () => {
	idp = await mockIssuer("cid", "sec");
	proc = spawn("node", ["build"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", AUTH_URL: ORIGIN, AUTH_KEY: KEY, AUTH_DATA: dir, OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: "cid", OIDC_CLIENT_SECRET: "sec", OIDC_NAME: "Mock", ORIGIN, PROTOCOL_HEADER: "" },
		stdio: ["ignore", "inherit", "inherit"],
	});
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${ORIGIN}/api/health`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("the service did not start");
});
after(async () => {
	proc.kill();
	await idp.close();
	rmSync(dir, { recursive: true, force: true });
});

const authreq = (host = "gym.test") => signToken(KEY, { typ: "authreq", aud: host, site: host, next: "/log", exp: Math.floor(Date.now() / 1000) + 300 });

/** Drive the provider round trip as `sub` and return the final response. */
async function signIn(b: ReturnType<typeof browser>, sub: string, req: string | null) {
	const start = await b.go(`/login/mock${req ? `?req=${encodeURIComponent(req)}` : ""}`);
	assert.equal(start.status, 302);
	const url = new URL(start.headers.get("location")!);
	idp.nonce = url.searchParams.get("nonce");
	idp.claims = { sub, email: `${sub}@example.com`, name: sub.toUpperCase() };
	return b.go(`/callback/mock?state=${url.searchParams.get("state")}&code=x`);
}

test("a site sign-in end to end: the first person becomes the owner and is handed to the site", async () => {
	const b = browser();
	const gate = await b.go(`/authorize?req=${authreq()}`);
	assert.equal(gate.status, 302);
	assert.match(gate.headers.get("location")!, /^\/login\?req=/);
	const page = await (await b.go(gate.headers.get("location")!)).text();
	assert.match(page, /Continue with Mock/);
	assert.match(page, /first/i);

	const back = await signIn(b, "ada", authreq());
	assert.equal(back.status, 302);
	const again = await b.go(back.headers.get("location")!);
	assert.equal(again.status, 302);
	const handoff = new URL(again.headers.get("location")!);
	assert.equal(handoff.origin + handoff.pathname, "https://gym.test/.celld/auth/callback");
	const claims = verifyToken(KEY, handoff.searchParams.get("token"), { typ: "handoff", aud: "gym.test" })!;
	assert.equal(claims.role, "owner");
	assert.equal(claims.name, "ADA");
	assert.equal(handoff.searchParams.get("next"), "/log");
});

test("a stranger waits; the owner approves them; then they get through", async () => {
	const owner = browser();
	await signIn(owner, "ada", null);
	const bob = browser();
	const waiting = await signIn(bob, "bob", authreq());
	assert.equal(waiting.headers.get("location"), "/pending");

	const people = await (await owner.go("/api/people")).json();
	const pending = people.people.find((p) => p.status === "pending");
	assert.equal(pending.name, "BOB");
	const approve = await owner.go(`/api/people/${pending.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }), headers: { "content-type": "application/json" } });
	assert.equal(approve.status, 200);

	const ok = await signIn(bob, "bob", authreq());
	const next = await bob.go(ok.headers.get("location")!);
	assert.match(next.headers.get("location")!, /^https:\/\/gym\.test\/\.celld\/auth\/callback\?token=/);
	// A member cannot open the admin API.
	assert.equal((await bob.go("/api/people")).status, 403);
});

test("the callback refuses a login that did not start in this browser", async () => {
	const victim = browser();
	const attacker = browser();
	const start = await attacker.go("/login/mock");
	const url = new URL(start.headers.get("location")!);
	idp.nonce = url.searchParams.get("nonce");
	const hijack = await victim.go(`/callback/mock?state=${url.searchParams.get("state")}&code=x`);
	assert.match(hijack.headers.get("location")!, /^\/login\?error=/);
	assert.ok(![...victim.jar.keys()].includes("celld_auth_session"));
});

test("unsafe API calls from another site are refused, and a forged request is not accepted", async () => {
	const owner = browser();
	await signIn(owner, "ada", null);
	const cross = await owner.go("/api/groups", { method: "POST", body: JSON.stringify({ name: "X" }), headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" } });
	assert.equal(cross.status, 403);
	const forged = signToken("z".repeat(40), { typ: "authreq", aud: "gym.test", site: "gym.test", exp: Math.floor(Date.now() / 1000) + 60 });
	const bad = await owner.go(`/authorize?req=${forged}`);
	assert.equal(bad.status, 302);
	assert.equal(bad.headers.get("location"), "/blocked?kind=bad");
});

test("an admin can manage groups and a site rule changes who is let in", async () => {
	const owner = browser();
	await signIn(owner, "ada", null);
	const post = (path, method, body) => owner.go(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
	const { id } = await (await post("/api/groups", "POST", { name: "Family" })).json();
	assert.equal((await post("/api/groups", "POST", { name: "family" })).status, 409);
	const bob = (await (await owner.go("/api/people")).json()).people.find((p) => p.name === "BOB");
	assert.equal((await post(`/api/groups/${id}/members`, "PUT", { users: [bob.id] })).status, 200);
	const groups = (await (await owner.go("/api/groups")).json()).groups;
	assert.equal(groups[0].members, 1);
	assert.equal((await owner.go("/api/activity")).status, 200);
	for (const page of ["/people", "/groups", "/sites", "/providers", "/activity", "/account"]) assert.equal((await owner.go(page)).status, 200, page);
	// The sign-in page is public; the people page needs a session.
	assert.equal((await fetch(`${ORIGIN}/people`, { redirect: "manual" })).status, 302);
});
