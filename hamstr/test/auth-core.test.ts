import assert from "node:assert/strict";
import { test } from "node:test";
import { signToken, verifyToken } from "../lib/auth/token.ts";
import { asJSON, authenticator, mockIssuer } from "./auth-helpers.ts";
import { createCore } from "../lib/auth/core.ts";

const KEY = "k".repeat(40);
const ORIGIN = "https://auth.example.com";
const profile = (sub: string, name = sub, email: string | null = null) => ({ subject: sub, email, emailVerified: true, name, username: null, picture: null });
const secs = () => Math.floor(Date.now() / 1000);

/** A fake celld admin API: declared policies per host and the overrides pushed. */
function fakeNode(declared: Record<string, string | null> = {}, status = 200) {
	const pushed: Record<string, string> = {};
	const f = async (url: any, init: any = {}) => {
		const u = new URL(String(url));
		const send = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
		if (u.pathname !== "/__admin/auth") return send(404, {});
		if (status !== 200) return send(status, { error: "nope" });
		const host = u.searchParams.get("host");
		if (init.method === "PUT") return (pushed[host!] = JSON.parse(init.body).mode), send(200, {});
		if (init.method === "DELETE") return delete pushed[host!], send(200, {});
		if (host) return send(200, { host, declared: declared[host] ?? null });
		return send(200, { sites: Object.entries(declared).map(([site, d]) => ({ site, declared: d, override: pushed[site] ?? null, mode: pushed[site] ?? d })) });
	};
	// What Hamstr's celld client offers: call(method, path below /__admin, JSON text).
	const call = async (method: string, path: string, body?: string) => {
		const res = await f(`http://node/__admin${path}`, { method, body });
		return { status: res.status, json: await res.json().catch(() => null) };
	};
	return { call, pushed };
}

function make(declared = {}, extra: any = {}, status = 200) {
	const node = fakeNode(declared, status);
	const core = createCore({ origin: ORIGIN, key: KEY, secret: KEY, dbPath: ":memory:", celld: { call: node.call }, ...extra });
	core.saveProvider("test", { kind: "oidc", name: "Tsidp", issuer: "http://idp.test", clientId: "c", clientSecret: "s" });
	return { core, node, pid: "tsidp" };
}
const flow = { req: null, invite: null, link: null };

test("the first person becomes the owner; later strangers wait in the queue", () => {
	const { core, pid } = make();
	const first = core.resolveIdentity(pid, profile("a", "Ada"), flow);
	assert.equal(first.kind, "signed-in");
	assert.equal((first as any).user.role, "owner");
	const stranger = core.resolveIdentity(pid, profile("b", "Bob", "bob@example.com"), flow);
	assert.equal(stranger.kind, "pending");
	assert.equal(core.pendingCount(), 1);
	// Asking again does not create a second person.
	assert.equal(core.resolveIdentity(pid, profile("b", "Bob"), flow).kind, "pending");
	assert.equal(core.people().length, 2);
	core.updatePerson((first as any).user.id, (stranger as any).user.id, { status: "active" });
	assert.equal(core.resolveIdentity(pid, profile("b"), flow).kind, "signed-in");
});

test("auto-approve lets a provider's people straight in as members", () => {
	const { core, pid } = make();
	core.resolveIdentity(pid, profile("a"), flow);
	core.setProvider("x", pid, { autoApprove: true });
	const r: any = core.resolveIdentity(pid, profile("c", "Cy"), flow);
	assert.equal(r.kind, "signed-in");
	assert.equal(r.user.role, "member");
});

test("an invite creates an active person with its role and groups, once", () => {
	const { core, pid } = make();
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const gid = core.createGroup(owner.user.id, "Family");
	const inv = core.createInvite(owner.user.id, { note: "for Mum", groups: [gid] });
	const r: any = core.resolveIdentity(pid, profile("m", "Mum"), { ...flow, invite: inv.token });
	assert.equal(r.kind, "signed-in");
	assert.deepEqual(core.person(r.user.id).groups, ["Family"]);
	assert.equal(core.invitesList()[0].status, "used");
	assert.equal(core.resolveIdentity(pid, profile("n"), { ...flow, invite: inv.token }).kind, "denied");
	assert.equal(core.openInvite(inv.token), undefined);
});

test("nobody can lock the service out", () => {
	const { core, pid } = make();
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const id = owner.user.id;
	assert.throws(() => core.updatePerson(id, id, { role: "admin" }), /at least one active owner/);
	assert.throws(() => core.updatePerson(id, id, { status: "disabled" }), /owner/);
	assert.throws(() => core.deletePerson(id, id), /owner/);
});

test("site access: only rules set here say who; owners and admins always enter", async () => {
	const { core, node, pid } = make({ "gym.test": "required", "open.test": "required" });
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const mem: any = core.resolveIdentity(pid, profile("m"), flow);
	core.updatePerson(owner.user.id, mem.user.id, { status: "active" });
	const u = core.userById(mem.user.id)!;

	assert.equal((await core.mayEnter(u, "open.test")).ok, true, "no rule: everyone let in");
	await core.setRule(owner.user.id, "gym.test", { access: "restricted", groups: [], users: [] });
	assert.equal((await core.mayEnter(u, "gym.test")).ok, false, "rule restricts to nobody");
	assert.equal(node.pushed["gym.test"], "required");
	assert.equal((await core.mayEnter(core.userById(owner.user.id)!, "gym.test")).ok, true, "owner always enters");
	const gid = core.createGroup(owner.user.id, "Family");
	await core.setRule(owner.user.id, "gym.test", { access: "restricted", groups: [gid], users: [] });
	assert.equal((await core.mayEnter(u, "gym.test")).ok, false);
	core.setPersonGroups(owner.user.id, u.id, [gid]);
	assert.equal((await core.mayEnter(u, "gym.test")).ok, true, "a group member");
	await core.setRule(owner.user.id, "gym.test", { access: "restricted", groups: [], users: [u.id] });
	assert.equal((await core.mayEnter(u, "gym.test")).ok, true, "a named person");
	await core.setRule(owner.user.id, "gym.test", { access: "public", groups: [], users: [] });
	assert.equal(node.pushed["gym.test"], "optional");
	const listed = (await core.sites()).find((s) => s.site === "gym.test")!;
	assert.equal(listed.declared, "required");
	assert.equal(listed.rule!.access, "public");
	await core.clearRule(owner.user.id, "gym.test");
	assert.equal(node.pushed["gym.test"], undefined);
});

test("a rule the router refuses is not saved, and a router outage opens nothing", async () => {
	const { core, pid } = make({ "gym.test": "required" }, {}, 500);
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	await assert.rejects(core.setRule(owner.user.id, "gym.test", { access: "restricted", groups: [], users: [] }), /refused/);
	await assert.rejects(core.sites(), /answered 500/);
	// A restricted rule saved earlier still holds while the router is unreachable.
	const ok = make({ "gym.test": "required" });
	const o2: any = ok.core.resolveIdentity(ok.pid, profile("a"), flow);
	const m2: any = ok.core.resolveIdentity(ok.pid, profile("m"), flow);
	ok.core.updatePerson(o2.user.id, m2.user.id, { status: "active" });
	await ok.core.setRule(o2.user.id, "gym.test", { access: "restricted", groups: [], users: [] });
	assert.equal((await ok.core.mayEnter(ok.core.userById(m2.user.id)!, "gym.test")).ok, false);
});

test("authorize: sends strangers to log in, denies the unlisted, and hands off to the router", async () => {
	const { core, pid } = make({ "gym.test": "required" });
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	await core.setRule(owner.user.id, "gym.test", { access: "restricted", groups: [], users: [] });
	const req = signToken(KEY, { typ: "authreq", aud: "gym.test", site: "gym.test", next: "/log?x=1", exp: secs() + 60 });
	assert.deepEqual(await core.authorize("garbage", null), { kind: "bad" });
	assert.deepEqual(await core.authorize(signToken("z".repeat(40), { typ: "authreq", aud: "gym.test", site: "gym.test", exp: secs() + 60 }), null), { kind: "bad" });
	assert.deepEqual(await core.authorize(req, null), { kind: "login" });

	const ownerSession = core.startSession(owner.user.id, "test");
	const ok: any = await core.authorize(req, ownerSession.token);
	assert.equal(ok.kind, "redirect");
	const url = new URL(ok.url);
	assert.equal(url.origin + url.pathname, "https://gym.test/.celld/auth/callback");
	assert.equal(url.searchParams.get("next"), "/log?x=1");
	const handoff = verifyToken(KEY, url.searchParams.get("token"), { typ: "handoff", aud: "gym.test" })!;
	assert.equal(handoff.sub, owner.user.id);
	assert.equal(handoff.role, "owner");
	assert.equal(verifyToken(KEY, url.searchParams.get("token"), { typ: "handoff", aud: "other.test" }), null);

	const mem: any = core.resolveIdentity(pid, profile("m"), { ...flow, invite: core.createInvite(owner.user.id, {}).token });
	const memSession = core.startSession(mem.user.id, "test");
	assert.equal(((await core.authorize(req, memSession.token)) as any).kind, "denied");

	core.updatePerson(owner.user.id, mem.user.id, { status: "disabled" });
	assert.deepEqual(await core.authorize(req, memSession.token), { kind: "login" }, "disabling ends sessions");
});

test("sessions can be listed and revoked, and logout ends one", () => {
	const { core, pid } = make();
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const a = core.startSession(owner.user.id, "oidc");
	const b = core.startSession(owner.user.id, "passkey");
	assert.equal(core.sessionsOf(owner.user.id).length, 2);
	assert.equal(core.revokeAll(owner.user.id, owner.user.id), 2);
	assert.equal(core.sessionUser(a.token), null);
	core.endSession(b.token);
	assert.equal(core.sessionsOf(owner.user.id).length, 0);
});

test("provider secrets are encrypted at rest and never listed", () => {
	const { core, pid } = make();
	const raw = core.db.prepare("SELECT config FROM providers WHERE id = ?").get(pid) as any;
	assert.doesNotMatch(raw.config, /"s"|idp\.test|clientSecret/);
	const listed = JSON.stringify(core.providersList());
	assert.doesNotMatch(listed, /"s"/);
	assert.equal(core.providersList().find((p) => p.id === pid)!.hasSecret, true);
	// Editing without a new secret keeps the old one.
	core.saveProvider("x", { id: pid, kind: "oidc", name: "Tsidp 2", clientId: "c2" });
	assert.equal(core.providersList().find((p) => p.id === pid)!.hasSecret, true);
});

test("a whole OIDC login: begin, the provider returns, a person is created; a replayed state fails", async () => {
	const idp = await mockIssuer("c", "s");
	try {
		const core = createCore({ origin: ORIGIN, key: KEY, secret: KEY, dbPath: ":memory:" });
		const pid = core.saveProvider("t", { kind: "oidc", name: "Mock", issuer: idp.issuer, clientId: "c", clientSecret: "s" });
		const start = new URL(await core.begin(pid, { req: "R" }));
		idp.nonce = start.searchParams.get("nonce");
		const back = new URLSearchParams({ state: start.searchParams.get("state")!, code: "code" });
		const out: any = await core.complete(pid, back);
		assert.equal(out.kind, "signed-in");
		assert.equal(out.req, "R");
		assert.equal(out.user.role, "owner");
		await assert.rejects(core.complete(pid, back), /expired/);
		await assert.rejects(core.complete(pid, new URLSearchParams({ state: "nope", code: "x" })), /expired/);
	} finally {
		await idp.close();
	}
});

test("passkeys: add one from an account, sign in with it; replays, other keys and junk are refused", async () => {
	const { core, pid } = make();
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const key = authenticator("auth.example.com", ORIGIN);
	const reg = await core.passkeyRegisterOptions(owner.user.id);
	await core.passkeyRegister(owner.user.id, reg.key, asJSON(key.credentialId, key.create(reg.publicKey.challenge)), "Laptop");
	assert.equal(core.person(owner.user.id).passkeys.length, 1);

	const login = await core.passkeyLoginOptions();
	const answer = asJSON(key.credentialId, key.get(login.publicKey.challenge));
	assert.equal((await core.passkeyLogin(login.key, answer)).id, owner.user.id);
	await assert.rejects(core.passkeyLogin(login.key, answer), /expired/, "a challenge is used once");

	const replay = await core.passkeyLoginOptions();
	await assert.rejects(core.passkeyLogin(replay.key, asJSON(key.credentialId, key.get(replay.publicKey.challenge, { count: 1 }))), /counter/i);
	const wrongOrigin = await core.passkeyLoginOptions();
	await assert.rejects(core.passkeyLogin(wrongOrigin.key, asJSON(key.credentialId, key.get(wrongOrigin.publicKey.challenge, { o: "https://evil.example" }))), /origin/i);
	const stranger = await core.passkeyLoginOptions();
	await assert.rejects(core.passkeyLogin(stranger.key, asJSON("unknown", authenticator("auth.example.com", ORIGIN).get(stranger.publicKey.challenge))), /not registered/);

	// Malformed registrations are a clean 400, never a crash.
	const junk = await core.passkeyRegisterOptions(owner.user.id);
	const short = asJSON("x", { clientDataJSON: key.create(junk.publicKey.challenge).clientDataJSON, attestationObject: Buffer.from([0xa0]).toString("base64url") });
	await assert.rejects(core.passkeyRegister(owner.user.id, junk.key, short, "x"), (err: any) => err.status === 400);

	// The last way in cannot be removed from the account page.
	core.unlinkIdentity(owner.user.id, pid, "a");
	assert.throws(() => core.removePasskey(owner.user.id, key.credentialId), /only way/);
});

test("groups: names are validated and unique; members can be set", () => {
	const { core, pid } = make();
	const owner: any = core.resolveIdentity(pid, profile("a"), flow);
	const gid = core.createGroup(owner.user.id, "Kids");
	assert.throws(() => core.createGroup(owner.user.id, "kids"), /exists/);
	assert.throws(() => core.createGroup(owner.user.id, "bad/name"), /group names/);
	core.setMembers(owner.user.id, gid, [owner.user.id, "ghost"]);
	assert.deepEqual(core.groupsList()[0].memberIds, [owner.user.id]);
	core.deleteGroup(owner.user.id, gid);
	assert.equal(core.groupsList().length, 0);
});
