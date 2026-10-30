// Hamstr against a mock IdP, a mock celld node and a real Hamstr Store.
// Run: npm test --prefix hamstr
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createStore } from "../../store/server.mjs";
import { bundle, call, manifest } from "../../store/test/helpers.mjs";
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
	it("serves its own static assets without taking the server down", async () => {
		// adapter-node answers these itself (it returns nothing), while pages go
		// through SvelteKit (it returns a promise). Both must stay in the context.
		const b = new Browser(port);
		// The shared design system (copied from packages/ui) and the shell's own styles.
		const ui = await b.request("GET", "/ui.css", { host: SHELL });
		assert.equal(ui.status, 200);
		assert.match(ui.headers["content-type"], /text\/css/);
		assert.match(ui.text, /\.grain-frame/);
		const css = await b.request("GET", "/shell.css", { host: SHELL });
		assert.equal(css.status, 200);
		assert.match(css.text, /\.tiles/);
		assert.equal((await b.request("GET", "/favicon.svg", { host: SHELL })).status, 200);
		const page = await b.request("GET", "/", { host: SHELL });
		const asset = /\/_app\/immutable\/[^"' ]+\.js/.exec(page.text);
		assert.ok(asset, "the page references its JS bundle");
		assert.equal((await b.request("GET", asset[0], { host: SHELL })).status, 200);
		assert.equal((await b.request("GET", "/api/health", { host: SHELL })).status, 200, "still alive");
	});
	it("serves the shell to signed-out visitors but no data", async () => {
		const b = new Browser(port);
		const page = await b.request("GET", "/", { host: SHELL });
		assert.equal(page.status, 200);
		assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
		assert.match(page.headers["content-security-policy"], /frame-src http:\/\/\*\.grains\.test/);
		assert.match(page.headers["content-security-policy"], /form-action 'self'(;|$)/);
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
	it("opens a single-instance app's one grain, making it on first open", async () => {
		await publish({ slug: "family", name: "Family", instances: "single" }, "eeeeeeeeeeee");
		assert.equal((await apiCall(ada, "POST", "/api/apps", { slug: "family" })).status, 200);
		const apps = (await bob.request("GET", "/api/apps", { host: SHELL })).json.apps;
		assert.equal(apps.find((a) => a.slug === "family").instances, "single");
		assert.equal(apps.find((a) => a.slug === "board").instances, "many");
		// Two taps at once still make one grain.
		const [a, b] = await Promise.all([apiCall(bob, "POST", "/api/apps/family/open", {}), apiCall(bob, "POST", "/api/apps/family/open", {})]);
		assert.equal(a.status, 201, a.text);
		assert.equal(b.json.grain.id, a.json.grain.id);
		assert.equal(a.json.grain.title, "Family");
		const again = await apiCall(bob, "POST", "/api/apps/family/open", {});
		assert.equal(again.status, 200);
		assert.equal(again.json.grain.id, a.json.grain.id);
		// Everyone gets their own; the trash does not count.
		const ada1 = (await apiCall(ada, "POST", "/api/apps/family/open", {})).json.grain;
		assert.notEqual(ada1.id, a.json.grain.id);
		await apiCall(ada, "POST", `/api/grains/${ada1.id}/trash`, {});
		const ada2 = await apiCall(ada, "POST", "/api/apps/family/open", {});
		assert.equal(ada2.status, 201);
		assert.notEqual(ada2.json.grain.id, ada1.id);
		// Many-instance apps are opened from their own page instead.
		assert.equal((await apiCall(bob, "POST", "/api/apps/board/open", {})).status, 409);
		assert.equal((await apiCall(bob, "POST", "/api/apps/nope/open", {})).status, 404);
		assert.equal((await bob.request("POST", "/api/apps/family/open", { host: SHELL, headers: { origin: "http://evil.test" }, json: {} })).status, 403);
		for (const g of [ada1, ada2.json.grain]) {
			await apiCall(ada, "POST", `/api/grains/${g.id}/trash`, {});
			assert.equal((await apiCall(ada, "DELETE", `/api/grains/${g.id}`)).status, 200);
		}
	});
	it("names a new grain after its app and shows it on the app's page", async () => {
		const r = await apiCall(bob, "POST", "/api/grains", { slug: "plain" });
		assert.equal(r.json.grain.title, "Untitled Plain");
		const home = await bob.request("GET", "/", { host: SHELL });
		assert.match(home.text, /href="\/a\/plain"/);
		assert.match(home.text, /href="\/a\/family"/);
		const appPage = await bob.request("GET", "/a/plain", { host: SHELL });
		assert.equal(appPage.status, 200);
		assert.ok(appPage.text.includes(`/g/${r.json.grain.id}`));
		assert.equal((await bob.request("GET", "/apps", { host: SHELL })).headers.location, "/store");
		await apiCall(bob, "POST", `/api/grains/${r.json.grain.id}/trash`, {});
		assert.equal((await apiCall(bob, "DELETE", `/api/grains/${r.json.grain.id}`)).status, 200);
	});
	it("downloads a grain's data from the app's export path, as the owner only", async () => {
		await publish({ slug: "notes", name: "Notes", export: "/export?all=1" }, "ffffffffffff");
		assert.equal((await apiCall(ada, "POST", "/api/apps", { slug: "notes" })).status, 200);
		const apps = (await bob.request("GET", "/api/apps", { host: SHELL })).json.apps;
		assert.equal(apps.find((a) => a.slug === "notes").canExport, true);
		assert.equal(apps.find((a) => a.slug === "plain").canExport, false);
		const g = (await apiCall(bob, "POST", "/api/grains", { slug: "notes", title: "Trip: plans/ideas" })).json.grain;
		const r = await bob.request("GET", `/api/grains/${g.id}/export`, { host: SHELL, headers: sameOrigin });
		assert.equal(r.status, 200, r.text);
		assert.match(r.headers["content-disposition"], /^attachment; filename="Trip- plans-ideas \d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''/);
		assert.equal(r.headers["x-content-type-options"], "nosniff");
		// What the app saw: its own path, the owner's identity, and the proxy token.
		assert.equal(r.json.host, grainHost(g.id));
		assert.equal(r.json.path, "/export?all=1");
		assert.equal(r.json.headers["x-hamstr-role"], "owner");
		assert.equal(r.json.headers["x-hamstr-export"], "1");
		assert.match(r.json.headers["x-hamstr-user-id"], /^[a-f0-9]{32}$/);
		assert.equal(r.headers["x-celld-proxy-token"], undefined);
		// Nobody else, not from another site, and not from an app without export.
		assert.equal((await ada.request("GET", `/api/grains/${g.id}/export`, { host: SHELL })).status, 404);
		assert.equal((await bob.request("GET", `/api/grains/${g.id}/export`, { host: SHELL, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
		const p = (await apiCall(bob, "POST", "/api/grains", { slug: "plain" })).json.grain;
		const none = await bob.request("GET", `/api/grains/${p.id}/export`, { host: SHELL });
		assert.equal(none.status, 404);
		assert.match(none.json.error, /can't export/);
		await apiCall(bob, "POST", `/api/grains/${g.id}/trash`, {});
		assert.equal((await bob.request("GET", `/api/grains/${g.id}/export`, { host: SHELL })).status, 404);
		for (const id of [g.id, p.id]) {
			await apiCall(bob, "POST", `/api/grains/${id}/trash`, {});
			assert.equal((await apiCall(bob, "DELETE", `/api/grains/${id}`)).status, 200);
		}
	});
	it("shows an app's items and trash on its page", async () => {
		const g = (await apiCall(bob, "POST", "/api/grains", { slug: "plain", title: "Old list" })).json.grain;
		await apiCall(bob, "POST", `/api/grains/${g.id}/trash`, {});
		const html = (await bob.request("GET", "/a/plain?tab=trash", { host: SHELL })).text;
		assert.match(html, /Old list/);
		assert.match(html, /Trash <span class="count">1<\/span>/);
		assert.equal((await bob.request("GET", "/a/nope", { host: SHELL })).status, 200);
		assert.match((await bob.request("GET", "/a/nope", { host: SHELL })).text, /not installed/);
		assert.equal((await apiCall(bob, "DELETE", `/api/grains/${g.id}`)).status, 200);
	});
	it("shows an app's store details, versions and what it can do", async () => {
		const page = await bob.request("GET", "/store/board", { host: SHELL });
		assert.equal(page.status, 200);
		assert.match(page.text, /<h1>Board<\/h1>/);
		assert.match(page.text, /Installed/);
		const caps = (await bob.request("GET", "/store/board?tab=permissions", { host: SHELL })).text;
		assert.match(caps, /Can pin/);
		assert.match(caps, /No internet access/);
		assert.match((await bob.request("GET", "/store/fetcher?tab=permissions", { host: SHELL })).text, /api\.example\.com/);
		assert.match((await bob.request("GET", "/store/board?tab=versions", { host: SHELL })).text, /v1\.0\.0/);
		assert.match((await bob.request("GET", "/store/nope", { host: SHELL })).text, /not in the store/);
		assert.match((await bob.request("GET", "/store?q=fetch", { host: SHELL })).text, /Fetcher/);
		assert.doesNotMatch((await bob.request("GET", "/store?q=fetch", { host: SHELL })).text, /data-slug="plain"/);
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

describe("privacy", () => {
	it("keeps an item to its owner: others cannot list, open, change or download it", async () => {
		const eve = await signIn(EVE);
		assert.equal((await eve.request("GET", "/api/grains", { host: SHELL })).json.mine.length, 0);
		assert.equal((await eve.request("GET", `/api/grains/${board.id}`, { host: SHELL })).status, 404);
		assert.equal((await apiCall(eve, "POST", `/api/grains/${board.id}/open`, { path: "/" })).status, 404);
		assert.equal((await apiCall(eve, "PATCH", `/api/grains/${board.id}`, { title: "Mine now" })).status, 404);
		assert.equal((await apiCall(eve, "POST", `/api/grains/${board.id}/trash`, {})).status, 404);
		assert.equal((await eve.request("GET", `/api/grains/${board.id}/export`, { host: SHELL })).status, 404);
		assert.equal((await eve.request("GET", "/", { host: grainHost(board.id) })).status, 401);
		assert.match((await eve.request("GET", `/g/${board.id}`, { host: SHELL })).text, /Nothing here/);
	});
	it("has no share links any more", async () => {
		assert.equal((await apiCall(bob, "POST", `/api/grains/${board.id}/shares`, { role: "viewer" })).status, 404);
		assert.equal((await new Browser(port).request("GET", `/s/${"a".repeat(32)}`, { host: SHELL })).status, 404);
		assert.equal((await bob.request("GET", "/shared", { host: SHELL })).status, 404);
		assert.equal((await bob.request("GET", "/api/grains", { host: SHELL })).json.shared, undefined);
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
	it("uninstalls an app for everyone, deleting its items only when told to", async () => {
		const bobs = (await apiCall(bob, "POST", "/api/apps/family/open", {})).json.grain;
		const adas = (await apiCall(ada, "POST", "/api/apps/family/open", {})).json.grain;
		await apiCall(ada, "POST", `/api/grains/${adas.id}/trash`, {});
		const info = await ada.request("GET", "/api/apps/family", { host: SHELL });
		assert.deepEqual(info.json.usage, { items: 2, mine: 1, others: 1, people: 2 });
		assert.equal((await apiCall(bob, "DELETE", "/api/apps/family?items=delete")).status, 403, "admins only");
		assert.equal((await ada.request("DELETE", "/api/apps/family?items=delete", { host: SHELL, headers: { origin: "http://evil.test" } })).status, 403);
		const kept = await apiCall(ada, "DELETE", "/api/apps/family");
		assert.equal(kept.status, 409);
		assert.match(kept.json.error, /2 items/);
		assert.ok(celld.sites.has(grainHost(bobs.id)));
		const r = await apiCall(ada, "DELETE", "/api/apps/family?items=delete");
		assert.equal(r.status, 200, r.text);
		assert.equal(r.json.deleted, 2);
		for (const g of [bobs, adas]) assert.equal(celld.sites.has(grainHost(g.id)), false);
		assert.equal((await bob.request("GET", `/api/grains/${bobs.id}`, { host: SHELL })).status, 404);
		assert.equal((await bob.request("GET", "/api/apps/family", { host: SHELL })).status, 404);
		assert.doesNotMatch((await bob.request("GET", "/", { host: SHELL })).text, /href="\/a\/family"/);
		assert.equal((await apiCall(ada, "DELETE", "/api/apps/family")).status, 404);
		// Bob's Feeds goes with Fetcher.
		assert.equal((await apiCall(ada, "DELETE", "/api/apps/fetcher?items=delete")).status, 200);
	});
});
