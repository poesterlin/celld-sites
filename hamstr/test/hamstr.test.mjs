// Hamstr against a mock IdP, a mock celld node and a real Cubby store.
// Run: npm test --prefix hamstr
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createStore } from "../../cubby/server.mjs";
import { bundle, call, manifest } from "../../cubby/test/helpers.mjs";
import { createHamstr, siteOf } from "../server.mjs";
import { Browser, mockCelld, mockIdp } from "./helpers.mjs";

const SHELL = "hamstr.test";
const ORIGIN = { origin: `http://${SHELL}` };
const ADA = { sub: "u-ada", email: "ada@example.com", name: "Ada Lovelace", username: "ada" };
const BOB = { sub: "u-bob", email: "bob@example.com", name: "Bob Builder", username: "bob" };
const EVE = { sub: "u-eve", email: "eve@example.com", name: "Eve", username: "eve" };
const ROLES = {
	permissions: [{ id: "pin" }, { id: "moderate" }],
	roles: [
		{ id: "editor", title: "Can pin", permissions: ["pin"], default: true },
		{ id: "viewer", title: "Can view", permissions: [] },
	],
};

const dir = mkdtempSync(join(tmpdir(), "hamstr-test-"));
let idp;
let celld;
let store;
let storeBase;
let publisherToken;
let hamstr;
let port;

async function publish(over, version = "aaaaaaaaaaaa", files = { "index.html": `<h1>${version}</h1>` }) {
	const m = manifest(over);
	const created = await call(storeBase, `/api/v1/apps/${m.slug}/releases`, { method: "POST", token: publisherToken, json: { manifest: m } });
	assert.equal(created.status, 201, created.text);
	const bytes = await bundle({ version, files });
	const up = await call(storeBase, created.body.upload.url, { method: "PUT", token: publisherToken, body: bytes, headers: { "content-type": "application/gzip" } });
	assert.equal(up.status, 201, up.text);
}

async function signIn(user, next = "/", onPort = port) {
	const browser = new Browser(onPort);
	idp.nextUser = user;
	const start = await browser.request("GET", `/auth/login?next=${encodeURIComponent(next)}`, { host: SHELL });
	assert.equal(start.status, 303);
	const authorize = new URL(start.headers.location);
	assert.equal(authorize.origin, idp.issuer);
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	const back = await fetch(authorize, { redirect: "manual" });
	const callback = new URL(back.headers.get("location"));
	browser.last = await browser.request("GET", callback.pathname + callback.search, { host: SHELL });
	return browser;
}
const apiCall = (browser, method, path, json) => browser.request(method, path, { host: SHELL, headers: ORIGIN, ...(json !== undefined && { json }) });

/** Open a grain the way the shell does: ticket, then the grain's enter URL. */
async function enter(browser, grainId, path = "/") {
	const r = await apiCall(browser, "POST", `/api/grains/${grainId}/open`, { path });
	assert.equal(r.status, 200, r.text);
	return follow(browser, r.json.url);
}
async function follow(browser, absolute) {
	const url = new URL(absolute);
	return browser.request("GET", url.pathname + url.search, { host: url.hostname });
}
const grainHost = (id) => `grain-${id}.grains.test`;
const sameOrigin = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };

before(async () => {
	idp = await mockIdp();
	celld = await mockCelld();
	store = createStore({ dataDir: join(dir, "store"), rateLimit: false, logging: false });
	storeBase = `http://127.0.0.1:${(await store.listen(0, "127.0.0.1")).port}`;
	const reg = await call(storeBase, "/api/v1/publishers", { method: "POST", json: { name: "pub", password: "correct horse battery" } });
	publisherToken = reg.body.token;
	await publish({ slug: "board", name: "Board", icon: "📌", ...ROLES });
	await publish({ slug: "plain", name: "Plain", icon: "▫" }, "bbbbbbbbbbbb");
	await publish({ slug: "fetcher", name: "Fetcher", egress: ["api.example.com"] }, "cccccccccccc");
	hamstr = createHamstr({
		dataDir: join(dir, "hamstr"),
		shellHost: SHELL,
		grainDomain: "grains.test",
		scheme: "http",
		store: storeBase,
		celldApi: celld.api,
		adminToken: celld.adminToken,
		proxyToken: celld.proxyToken,
		secret: "test-secret",
		oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
		admins: ["ada@example.com"],
		allowed: ["ada@example.com", "bob", "u-eve"],
		logging: false,
	});
	port = (await hamstr.listen(0, "127.0.0.1")).port;
});

after(async () => {
	await hamstr.close();
	await store.close();
	await celld.close();
	await idp.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("cookie mode", () => {
	it("treats shell and grains on one registrable domain as same-site", () => {
		assert.equal(siteOf("hamstr.oesterlin.dev"), siteOf("grain-abc.oesterlin.dev"));
		assert.notEqual(siteOf("hamstr.localhost"), siteOf("grain-abc.localhost"));
		assert.notEqual(siteOf("hamstr.test"), siteOf("grain-abc.grains.test"));
		assert.equal(siteOf("localhost"), "localhost");
	});
});

describe("hosts and robustness", () => {
	it("answers health, refuses unknown hosts and survives a malformed Host", async () => {
		const b = new Browser(port);
		assert.equal((await b.request("GET", "/api/health", { host: "127.0.0.1:3000" })).status, 200);
		assert.equal((await b.request("GET", "/", { host: "elsewhere.test" })).status, 404);
		assert.equal((await b.request("GET", "/api/health", { host: `${SHELL}:abc` })).status, 200, "no crash");
		assert.equal((await b.request("GET", "/api/health", { host: SHELL })).status, 200);
	});
	it("serves the shell to signed-out visitors but no data", async () => {
		const b = new Browser(port);
		const page = await b.request("GET", "/", { host: SHELL });
		assert.equal(page.status, 200);
		assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
		assert.match(page.headers["content-security-policy"], /frame-src http:\/\/\*\.grains\.test/);
		// Guest links POST and then redirect into a grain; Chromium checks the redirect too.
		assert.match(page.headers["content-security-policy"], /form-action 'self' http:\/\/\*\.grains\.test/);
		assert.equal((await b.request("GET", "/api/me", { host: SHELL })).status, 401);
	});
});

describe("sign-in", () => {
	it("signs in with PKCE and a verified ID token, then returns to `next`", async () => {
		const ada = await signIn(ADA, "/apps");
		assert.equal(ada.last.status, 303);
		assert.equal(ada.last.headers.location, "/apps");
		assert.match(ada.last.headers["set-cookie"][0], /HttpOnly; SameSite=Lax/);
		const me = await ada.request("GET", "/api/me", { host: SHELL });
		assert.equal(me.json.user.name, "Ada Lovelace");
		assert.equal(me.json.user.admin, true);
		const bob = await signIn(BOB);
		assert.equal((await bob.request("GET", "/api/me", { host: SHELL })).json.user.admin, false);
	});
	it("refuses tampered tokens and replayed or unknown state", async () => {
		for (const tamper of ["nonce", "aud", "expired", "signature"]) {
			idp.tamper = tamper;
			const b = await signIn(ADA);
			assert.equal(b.last.status, 502, tamper);
			assert.equal((await b.request("GET", "/api/me", { host: SHELL })).status, 401, tamper);
		}
		const b = new Browser(port);
		assert.equal((await b.request("GET", "/auth/callback?code=x&state=nope", { host: SHELL })).status, 400);
	});
	it("keeps out people who are not invited", async () => {
		const stranger = await signIn({ sub: "u-x", email: "x@example.com", name: "X" });
		assert.equal(stranger.last.status, 403);
		assert.equal((await stranger.request("GET", "/api/me", { host: SHELL })).status, 401);
	});
	it("makes everyone an admin with HAMSTR_ADMINS=*", async () => {
		const open = createHamstr({
			dataDir: join(dir, "hamstr-open"),
			shellHost: SHELL,
			grainDomain: "grains.test",
			scheme: "http",
			store: storeBase,
			celldApi: celld.api,
			adminToken: celld.adminToken,
			proxyToken: celld.proxyToken,
			secret: "s",
			oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
			admins: ["*"],
			logging: false,
		});
		const openPort = (await open.listen(0, "127.0.0.1")).port;
		try {
			const someone = await signIn({ sub: "u-z", email: "z@example.com", name: "Zed" }, "/", openPort);
			assert.equal(someone.last.status, 303);
			assert.equal((await someone.request("GET", "/api/me", { host: SHELL })).json.user.admin, true);
		} finally {
			await open.close();
		}
	});
	it("ignores a `next` that leaves the shell", async () => {
		const b = await signIn(BOB, "//evil.example/x");
		assert.equal(b.last.headers.location, "/");
	});
	it("signs out server-side, from the shell only", async () => {
		const b = await signIn(BOB);
		const cross = await b.request("POST", "/auth/logout", { host: SHELL, headers: { origin: "http://evil.test" } });
		assert.equal(cross.status, 403);
		const stolen = b.cookieHeader(SHELL);
		assert.equal((await b.request("POST", "/auth/logout", { host: SHELL, headers: ORIGIN })).status, 303);
		const replay = new Browser(port);
		assert.equal((await replay.request("GET", "/api/me", { host: SHELL, headers: { cookie: stolen } })).status, 401);
	});
});

let ada;
let bob;
let board; // a grain
describe("apps and grains", () => {
	before(async () => {
		ada = await signIn(ADA);
		bob = await signIn(BOB);
	});
	it("lets only admins install, and checks the app boots on a probe site", async () => {
		assert.equal((await apiCall(bob, "POST", "/api/apps", { slug: "board" })).status, 403);
		celld.calls.length = 0;
		const r = await apiCall(ada, "POST", "/api/apps", { slug: "board" });
		assert.equal(r.status, 200, r.text);
		assert.deepEqual(r.json.app.roles.map((x) => x.id), ["editor", "viewer"]);
		const seq = celld.calls.map((c) => `${c.method} ${c.path}`);
		assert.deepEqual(seq.slice(0, 2), ["POST /blobs/missing", "PUT /blob"]);
		assert.ok(seq.includes("PUT /code"));
		const probe = celld.calls.find((c) => c.path === "/check").query.host;
		assert.match(probe, /^grain-probe-[a-z0-9]{8}\.grains\.test$/);
		assert.ok(celld.calls.some((c) => c.method === "DELETE" && c.path === "/site" && c.query.id === probe), "probe removed");
		assert.equal(celld.sites.has(probe), false);
		assert.equal((await apiCall(ada, "POST", "/api/apps", { slug: "plain" })).status, 200);
	});
	it("refuses an app whose start-up check fails", async () => {
		celld.failCheck = true;
		const r = await apiCall(ada, "POST", "/api/apps", { slug: "fetcher", allowEgress: true });
		celld.failCheck = false;
		assert.equal(r.status, 422);
		assert.match(r.json.error, /start-up check/);
	});
	it("needs explicit consent for network access", async () => {
		const r = await apiCall(ada, "POST", "/api/apps", { slug: "fetcher" });
		assert.equal(r.status, 403);
		assert.match(r.json.error, /api\.example\.com/);
		assert.equal((await apiCall(ada, "POST", "/api/apps", { slug: "fetcher", allowEgress: true })).status, 200);
	});
	it("creates a grain as its own celld site, with the app's egress", async () => {
		celld.calls.length = 0;
		const r = await apiCall(bob, "POST", "/api/grains", { slug: "board", title: "Family board" });
		assert.equal(r.status, 201, r.text);
		board = r.json.grain;
		assert.match(board.id, /^[a-z0-9]{12}$/);
		assert.equal(board.role, "owner");
		assert.deepEqual(board.permissions, ["pin", "moderate"]);
		assert.deepEqual(
			celld.calls.map((c) => `${c.method} ${c.path} ${c.query.host}`),
			[`POST /stage ${grainHost(board.id)}`, `DELETE /egress ${grainHost(board.id)}`, `POST /activate ${grainHost(board.id)}`],
		);
		const f = await apiCall(bob, "POST", "/api/grains", { slug: "fetcher", title: "Feeds" });
		assert.ok(celld.calls.some((c) => c.method === "PUT" && c.path === "/egress" && c.body === '["api.example.com"]'));
		const listed = (await bob.request("GET", "/api/grains", { host: SHELL })).json;
		assert.deepEqual(listed.mine.map((g) => g.title).sort(), ["Family board", "Feeds"]);
		assert.equal((await ada.request("GET", "/api/grains", { host: SHELL })).json.mine.length, 0);
		assert.equal((await ada.request("GET", `/api/grains/${f.json.grain.id}`, { host: SHELL })).status, 404);
	});
	it("refuses cross-origin writes to the shell API", async () => {
		const evil = await bob.request("POST", "/api/grains", { host: SHELL, headers: { origin: "http://grain-x.grains.test" }, json: { slug: "board" } });
		assert.equal(evil.status, 403);
		const fetchSite = await bob.request("POST", "/api/grains", { host: SHELL, headers: { "sec-fetch-site": "same-site" }, json: { slug: "board" } });
		assert.equal(fetchSite.status, 403);
		const form = await bob.request("POST", "/api/grains", { host: SHELL, headers: { ...ORIGIN, "content-type": "text/plain" }, body: "{}" });
		assert.equal(form.status, 415);
	});
	it("refuses to remove an app that still has grains", async () => {
		const r = await apiCall(ada, "DELETE", "/api/apps/board");
		assert.equal(r.status, 409);
	});
});

describe("the grain proxy", () => {
	it("enters with a one-time ticket and forwards trusted identity only", async () => {
		const entered = await enter(bob, board.id, "/notes?x=1");
		assert.equal(entered.status, 303);
		assert.equal(entered.headers.location, "/notes?x=1");
		// hamstr.test and grains.test are different sites: a partitioned cookie.
		assert.match(entered.headers["set-cookie"][0], /^hamstr_grain=.*HttpOnly; SameSite=None; Secure; Partitioned/);
		const r = await bob.request("GET", "/notes?x=1", {
			host: grainHost(board.id),
			headers: { "x-hamstr-user-id": "forged", "x-hamstr-permissions": "moderate,admin", "x-celld-proxy-token": "guess", cookie: `${bob.cookieHeader(grainHost(board.id))}; app=1` },
		});
		assert.equal(r.status, 200, r.text);
		const h = r.json.headers;
		assert.equal(h["x-hamstr-role"], "owner");
		assert.equal(h["x-hamstr-permissions"], "pin,moderate");
		assert.equal(decodeURIComponent(h["x-hamstr-username"]), "Bob Builder");
		assert.match(h["x-hamstr-user-id"], /^[a-f0-9]{32}$/);
		assert.notEqual(h["x-hamstr-user-id"], "forged");
		assert.equal(h["x-hamstr-grain-id"], board.id);
		assert.equal(h.cookie, "app=1", "the grain session cookie never reaches the app");
		assert.equal(h["x-forwarded-proto"], "http");
		assert.equal(r.headers["content-security-policy"], `frame-ancestors http://${SHELL}`);
	});
	it("does not accept a ticket twice, or on another grain", async () => {
		const r = await apiCall(bob, "POST", `/api/grains/${board.id}/open`, { path: "/" });
		const url = new URL(r.json.url);
		const thief = new Browser(port);
		const other = await apiCall(bob, "POST", "/api/grains", { slug: "plain", title: "Other" });
		assert.equal((await thief.request("GET", url.pathname + url.search, { host: grainHost(other.json.grain.id) })).status, 403);
		const once = new Browser(port);
		assert.equal((await once.request("GET", url.pathname + url.search, { host: url.hostname })).status, 403, "ticket burned by the failed attempt");
	});
	it("sends visitors without a grain session back to the shell", async () => {
		const b = new Browser(port);
		const nav = await b.request("GET", "/deep/link", { host: grainHost(board.id), headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" } });
		assert.equal(nav.status, 303);
		assert.equal(nav.headers.location, `http://${SHELL}/g/${board.id}/open?path=${encodeURIComponent("/deep/link")}`);
		const frame = await b.request("GET", "/", { host: grainHost(board.id), headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" } });
		assert.equal(frame.status, 401);
		assert.match(frame.text, /target="_top"/);
		assert.equal((await b.request("GET", "/api/data", { host: grainHost(board.id) })).status, 401);
		// The top-level open path issues a ticket for a signed-in owner.
		const open = await bob.request("GET", `/g/${board.id}/open?path=%2Fdeep%2Flink`, { host: SHELL });
		assert.equal(open.status, 303);
		assert.match(open.headers.location, new RegExp(`^http://${grainHost(board.id)}/\\.hamstr/enter\\?ticket=`));
		const anon = await b.request("GET", `/g/${board.id}/open`, { host: SHELL });
		assert.match(anon.headers.location, /^\/auth\/login\?next=/);
	});
	it("keeps other origins, including other grains, from scripting a grain", async () => {
		const host = grainHost(board.id);
		const sub = await bob.request("GET", "/api/data", { host, headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" } });
		assert.equal(sub.status, 403);
		const post = await bob.request("POST", "/pin", { host, headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }, body: "text=hi" });
		assert.equal(post.status, 403);
		const legacy = await bob.request("POST", "/pin", { host, headers: { origin: "http://grain-other.grains.test" }, body: "text=hi" });
		assert.equal(legacy.status, 403);
		const own = await bob.request("POST", "/pin", { host, headers: { ...sameOrigin, origin: `http://${host}` }, body: "text=hi" });
		assert.equal(own.status, 200);
		assert.equal(own.json.body, "text=hi");
		const link = await bob.request("GET", "/", { host, headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } });
		assert.equal(link.status, 200, "a plain link from elsewhere still opens the grain");
	});
	it("lets a grain set cookies for itself only", async () => {
		const r = await bob.request("GET", "/setcookie", { host: grainHost(board.id) });
		assert.deepEqual(r.headers["set-cookie"], ["app=1; Path=/"]);
		assert.equal(r.headers["content-security-policy"], `default-src 'self', frame-ancestors http://${SHELL}`);
	});
	it("ends grain sessions when the shell session signs out", async () => {
		const carol = await signIn(BOB);
		await enter(carol, board.id);
		assert.equal((await carol.request("GET", "/", { host: grainHost(board.id) })).status, 200);
		await carol.request("POST", "/auth/logout", { host: SHELL, headers: ORIGIN });
		assert.equal((await carol.request("GET", "/", { host: grainHost(board.id) })).status, 401);
	});
});

describe("sharing", () => {
	let viewerLink;
	let editorLink;
	let viewerShareId;
	it("lets only the owner share, with the app's roles", async () => {
		assert.equal((await apiCall(ada, "POST", `/api/grains/${board.id}/shares`, { role: "viewer" })).status, 404);
		assert.equal((await apiCall(bob, "POST", `/api/grains/${board.id}/shares`, { role: "admin" })).status, 400);
		const v = await apiCall(bob, "POST", `/api/grains/${board.id}/shares`, { role: "viewer", label: "Grandma" });
		assert.equal(v.status, 201);
		viewerLink = new URL(v.json.url);
		viewerShareId = v.json.share.id;
		assert.match(viewerLink.pathname, /^\/s\/[A-Za-z0-9_-]{32}$/);
		const e = await apiCall(bob, "POST", `/api/grains/${board.id}/shares`, {});
		assert.equal(e.json.share.role, "editor", "the app's default role");
		editorLink = new URL(e.json.url);
		const list = await bob.request("GET", `/api/grains/${board.id}/shares`, { host: SHELL });
		assert.equal(list.json.shares.length, 2);
		assert.equal(JSON.stringify(list.json).includes(viewerLink.pathname.slice(3)), false, "links are not stored or shown again");
	});
	it("lets a guest open a link with exactly its role", async () => {
		const guest = new Browser(port);
		const landing = await guest.request("GET", viewerLink.pathname, { host: SHELL });
		assert.equal(landing.status, 200);
		assert.match(landing.text, /Family board/);
		assert.match(landing.text, /Can view/);
		assert.equal(landing.headers["referrer-policy"], "no-referrer");
		const crossOpen = await guest.request("POST", `${viewerLink.pathname}/open`, { host: SHELL, headers: { "sec-fetch-site": "cross-site" } });
		assert.equal(crossOpen.status, 403);
		const open = await guest.request("POST", `${viewerLink.pathname}/open`, { host: SHELL, headers: ORIGIN });
		assert.equal(open.status, 303);
		assert.equal((await follow(guest, open.headers.location)).status, 303);
		const r = await guest.request("GET", "/", { host: grainHost(board.id) });
		assert.equal(r.json.headers["x-hamstr-role"], "viewer");
		assert.equal(r.json.headers["x-hamstr-permissions"], "");
		assert.equal(r.json.headers["x-hamstr-username"], "Guest");
		assert.equal(r.json.headers["x-hamstr-user-id"], undefined);
		guestBrowser = guest;
	});
	let guestBrowser;
	it("keeps a link for signed-in people and combines roles", async () => {
		const eve = await signIn(EVE);
		const landing = await eve.request("GET", viewerLink.pathname, { host: SHELL });
		assert.equal(landing.status, 303);
		assert.equal(landing.headers.location, `/g/${board.id}`);
		const shared = (await eve.request("GET", "/api/grains", { host: SHELL })).json.shared;
		assert.deepEqual(shared.map((g) => [g.title, g.role]), [["Family board", "viewer"]]);
		await eve.request("GET", editorLink.pathname, { host: SHELL });
		const g = (await eve.request("GET", `/api/grains/${board.id}`, { host: SHELL })).json.grain;
		assert.equal(g.role, "editor");
		assert.deepEqual(g.permissions, ["pin"]);
		assert.equal(g.isOwner, false);
		await enter(eve, board.id);
		const r = await eve.request("GET", "/", { host: grainHost(board.id) });
		assert.equal(r.json.headers["x-hamstr-permissions"], "pin");
		assert.equal(decodeURIComponent(r.json.headers["x-hamstr-username"]), "Eve");
		// Not the owner: no renaming, trashing or sharing.
		assert.equal((await apiCall(eve, "PATCH", `/api/grains/${board.id}`, { title: "Mine now" })).status, 403);
		assert.equal((await apiCall(eve, "POST", `/api/grains/${board.id}/trash`, {})).status, 403);
		assert.equal((await apiCall(eve, "POST", `/api/grains/${board.id}/shares`, {})).status, 403);
		// Leaving removes it from the list and the access.
		assert.equal((await apiCall(eve, "POST", `/api/grains/${board.id}/leave`, {})).status, 200);
		assert.equal((await eve.request("GET", "/api/grains", { host: SHELL })).json.shared.length, 0);
		assert.equal((await eve.request("GET", "/", { host: grainHost(board.id) })).status, 401);
	});
	it("turns a revoked link off everywhere at once", async () => {
		assert.equal((await guestBrowser.request("GET", "/", { host: grainHost(board.id) })).status, 200);
		assert.equal((await apiCall(ada, "DELETE", `/api/shares/${viewerShareId}`)).status, 404, "only the owner revokes");
		assert.equal((await apiCall(bob, "DELETE", `/api/shares/${viewerShareId}`)).status, 200);
		assert.equal((await guestBrowser.request("GET", "/", { host: grainHost(board.id) })).status, 401);
		const dead = await new Browser(port).request("GET", viewerLink.pathname, { host: SHELL });
		assert.equal(dead.status, 404);
		assert.match(dead.text, /doesn't work anymore/);
	});
});

describe("trash and updates", () => {
	it("hides a trashed grain, restores it, and deletes it for good", async () => {
		const g = (await apiCall(bob, "POST", "/api/grains", { slug: "plain", title: "Scratch" })).json.grain;
		await enter(bob, g.id);
		assert.equal((await apiCall(bob, "DELETE", `/api/grains/${g.id}`)).status, 409, "trash first");
		assert.equal((await apiCall(bob, "POST", `/api/grains/${g.id}/trash`, {})).status, 200);
		assert.equal((await bob.request("GET", "/", { host: grainHost(g.id) })).status, 404);
		const lists = (await bob.request("GET", "/api/grains", { host: SHELL })).json;
		assert.ok(lists.trash.some((t) => t.id === g.id));
		assert.ok(!lists.mine.some((t) => t.id === g.id));
		assert.equal((await apiCall(bob, "POST", `/api/grains/${g.id}/restore`, {})).status, 200);
		await apiCall(bob, "POST", `/api/grains/${g.id}/trash`, {});
		assert.equal((await apiCall(bob, "DELETE", `/api/grains/${g.id}`)).status, 200);
		assert.equal(celld.sites.has(grainHost(g.id)), false);
		assert.equal((await bob.request("GET", `/api/grains/${g.id}`, { host: SHELL })).status, 404);
	});
	it("moves every grain to a new release and keeps roles working", async () => {
		await publish({ slug: "board", name: "Board", icon: "📌", version: "1.1.0", ...ROLES }, "dddddddddddd");
		const updates = await ada.request("GET", "/api/apps/updates", { host: SHELL });
		assert.equal(updates.json.updates.board.version, "1.1.0");
		const r = await apiCall(ada, "POST", "/api/apps", { slug: "board" });
		assert.equal(r.status, 200, r.text);
		assert.equal(r.json.updatedGrains, 1);
		assert.equal(celld.sites.get(grainHost(board.id)), "dddddddddddd");
		const g = (await bob.request("GET", `/api/grains/${board.id}`, { host: SHELL })).json.grain;
		assert.equal(g.role, "owner");
	});
	it("renames grains for their owner", async () => {
		const r = await apiCall(bob, "PATCH", `/api/grains/${board.id}`, { title: "  Kitchen board  " });
		assert.equal(r.json.grain.title, "Kitchen board");
		assert.equal((await apiCall(bob, "PATCH", `/api/grains/${board.id}`, { title: " " })).status, 400);
	});
});
