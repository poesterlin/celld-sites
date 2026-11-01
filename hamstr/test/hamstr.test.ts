// Hamstr against a mock IdP, a mock celld node and a real Hamstr Store.
// Run: npm test --prefix hamstr
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createStore } from "../../store/server.ts";
import { bundle, call, manifest } from "../../store/test/helpers.ts";
import { grainPolicy } from "../lib/proxy.ts";
import { createHamstr, siteOf } from "../server.ts";
import { Browser, mockCelld, mockIdp } from "./helpers.ts";

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
	const created = await call(storeBase, `/api/v1/apps/pub/${m.slug}/releases`, { method: "POST", token: publisherToken, json: { manifest: m } });
	assert.equal(created.status, 201, created.text);
	const bytes = await bundle({ version, files });
	const up = await call(storeBase, created.body.upload.url, { method: "PUT", token: publisherToken, body: bytes, headers: { "content-type": "application/gzip" } });
	assert.equal(up.status, 201, up.text);
}

async function signIn(user, next = "/", onPort = port) {
	const browser = new Browser(onPort);
	idp.nextUser = user;
	const start = await browser.request("GET", `/auth/login/${hamstr.core.seededProvider}?next=${encodeURIComponent(next)}`, { host: SHELL });
	assert.equal(start.status, 302);
	const authorize = new URL(start.headers.location);
	assert.equal(authorize.origin, idp.issuer);
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	const back = await fetch(authorize, { redirect: "manual" });
	const callback = new URL(back.headers.get("location"));
	browser.last = await browser.request("GET", callback.pathname + callback.search, { host: SHELL });
	return browser;
}
const apiCall = (browser: any, method: string, path: string, json?: unknown) => browser.request(method, path, { host: SHELL, headers: ORIGIN, ...(json !== undefined && { json }) });

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
	const reg = await call(storeBase, "/api/v1/publishers", { method: "POST", json: { name: "pub", password: "correct horse battery", acceptPolicy: true } });
	publisherToken = reg.body.token;
	await publish({ slug: "board", name: "Board", icon: "📌", ...ROLES });
	await publish({ slug: "plain", name: "Plain", icon: "▫" }, "bbbbbbbbbbbb");
	await publish({ slug: "fetcher", name: "Fetcher", egress: ["api.example.com"] }, "cccccccccccc");
	await publish({ slug: "listener", name: "Listener", devices: ["microphone"] }, "dddddddddddd");
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
		logging: false,
	});
	port = (await hamstr.listen(0, "127.0.0.1")).port;
	// Ada is the first person in, so she owns this Hamstr; the provider then lets
	// everyone else in without waiting (the waiting list has its own test).
	await signIn(ADA);
	hamstr.core.accounts.setProvider("test", hamstr.core.seededProvider, { autoApprove: true });
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
	it("signs in with PKCE and a checked ID token, then returns to `next`", async () => {
		const ada = await signIn(ADA, "/apps");
		assert.equal(ada.last.status, 303, ada.last.headers.location);
		assert.equal(ada.last.headers.location, "/apps");
		assert.match(ada.last.headers["set-cookie"][0], /HttpOnly; SameSite=Lax/);
		const me = await ada.request("GET", "/api/me", { host: SHELL });
		assert.equal(me.json.user.name, "Ada Lovelace");
		assert.equal(me.json.user.admin, true);
		const bob = await signIn(BOB);
		assert.equal((await bob.request("GET", "/api/me", { host: SHELL })).json.user.admin, false);
	});
	it("refuses tampered tokens and replayed or unknown state", async () => {
		// The ID token comes straight from the token endpoint, so (as OIDC Core 3.1.3.7
		// allows) its signature is not what is checked; its claims are.
		for (const tamper of ["nonce", "aud", "expired"]) {
			idp.tamper = tamper;
			const b = await signIn(ADA);
			assert.equal(b.last.status, 302, tamper);
			assert.match(b.last.headers.location, /^\/auth\/login\?error=/, tamper);
			assert.equal((await b.request("GET", "/api/me", { host: SHELL })).status, 401, tamper);
		}
		const b = new Browser(port);
		const unknown = await b.request("GET", `/auth/callback/${hamstr.core.seededProvider}?code=x&state=nope`, { host: SHELL });
		assert.match(unknown.headers.location, /^\/auth\/login\?error=/);
	});
	it("puts strangers on the waiting list until an admin lets them in", async () => {
		const accounts = hamstr.core.accounts;
		accounts.setProvider("test", hamstr.core.seededProvider, { autoApprove: false });
		try {
			const stranger = await signIn({ sub: "u-x", email: "x@example.com", name: "X" });
			assert.equal(stranger.last.headers.location, "/auth/pending");
			assert.equal((await stranger.request("GET", "/api/me", { host: SHELL })).status, 401);
			const ada = await signIn(ADA);
			const waiting = (await apiCall(ada, "GET", "/api/admin/people")).json.people.find((p) => p.name === "X");
			assert.equal(waiting.status, "pending");
			assert.equal((await apiCall(ada, "PATCH", `/api/admin/people/${waiting.id}`, { status: "active" })).status, 200);
			const again = await signIn({ sub: "u-x", email: "x@example.com", name: "X" });
			assert.equal((await again.request("GET", "/api/me", { host: SHELL })).json.user.admin, false);
			// A member cannot reach the admin API.
			assert.equal((await apiCall(again, "GET", "/api/admin/people")).status, 403);
		} finally {
			accounts.setProvider("test", hamstr.core.seededProvider, { autoApprove: true });
		}
	});
	it("brings over people who signed in before accounts, keeping their ids", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const { mkdirSync } = await import("node:fs");
		const oldDir = join(dir, "hamstr-old");
		mkdirSync(oldDir, { recursive: true });
		const old = new DatabaseSync(join(oldDir, "hamstr.db"));
		old.exec("CREATE TABLE users (id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT, login TEXT, created_at TEXT NOT NULL, seen_at TEXT NOT NULL); PRAGMA user_version = 1;");
		old.prepare("INSERT INTO users VALUES ('olduserzed00001', 'u-z', 'Zed', 'z@example.com', 'zed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
		old.prepare("INSERT INTO users VALUES ('olduseryan00002', 'u-y', 'Yan', 'y@example.com', 'yan', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')").run();
		old.close();
		const upgraded = createHamstr({
			dataDir: oldDir,
			shellHost: SHELL,
			grainDomain: "grains.test",
			scheme: "http",
			store: storeBase,
			celldApi: celld.api,
			adminToken: celld.adminToken,
			proxyToken: celld.proxyToken,
			secret: "s",
			oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
			admins: ["y@example.com"],
			logging: false,
		});
		const upPort = (await upgraded.listen(0, "127.0.0.1")).port;
		try {
			const roles = Object.fromEntries(upgraded.core.accounts.people().map((p) => [p.id, p.role]));
			assert.deepEqual(roles, { olduserzed00001: "owner", olduseryan00002: "admin" });
			const zed = await signIn({ sub: "u-z", email: "z@example.com", name: "Zed" }, "/", upPort);
			const me = (await zed.request("GET", "/api/me", { host: SHELL })).json.user;
			assert.equal(me.id, "olduserzed00001");
			assert.equal(me.admin, true);
		} finally {
			await upgraded.close();
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
		assert.equal((await apiCall(bob, "POST", "/api/apps", { id: "pub/board" })).status, 403);
		celld.calls.length = 0;
		const r = await apiCall(ada, "POST", "/api/apps", { id: "pub/board" });
		assert.equal(r.status, 200, r.text);
		const seq = celld.calls.map((c) => `${c.method} ${c.path}`);
		assert.deepEqual(seq.slice(0, 2), ["POST /blobs/missing", "PUT /blob"]);
		assert.ok(seq.includes("PUT /code"));
		const probe = celld.calls.find((c) => c.path === "/check").query.host;
		assert.match(probe, /^grain-probe-[a-z0-9]{8}\.grains\.test$/);
		assert.ok(celld.calls.some((c) => c.method === "DELETE" && c.path === "/site" && c.query.id === probe), "probe removed");
		assert.equal(celld.sites.has(probe), false);
		assert.equal((await apiCall(ada, "POST", "/api/apps", { id: "pub/plain" })).status, 200);
	});
	it("refuses an app whose start-up check fails", async () => {
		celld.failCheck = true;
		const r = await apiCall(ada, "POST", "/api/apps", { id: "pub/fetcher", allowEgress: true });
		celld.failCheck = false;
		assert.equal(r.status, 422);
		assert.match(r.json.error, /start-up check/);
	});
	it("needs explicit consent for network access", async () => {
		const r = await apiCall(ada, "POST", "/api/apps", { id: "pub/fetcher" });
		assert.equal(r.status, 403);
		assert.match(r.json.error, /api\.example\.com/);
		assert.equal((await apiCall(ada, "POST", "/api/apps", { id: "pub/fetcher", allowEgress: true })).status, 200);
	});
	it("needs explicit consent for the microphone, and only then lists it", async () => {
		const r = await apiCall(ada, "POST", "/api/apps", { id: "pub/listener" });
		assert.equal(r.status, 403);
		assert.match(r.json.error, /microphone/);
		assert.equal((await apiCall(ada, "POST", "/api/apps", { id: "pub/listener", allowEgress: true })).status, 200);
		const apps = await apiCall(ada, "GET", "/api/apps");
		assert.deepEqual(apps.json.apps.find((a) => a.slug === "listener").devices, ["microphone"]);
		assert.deepEqual(apps.json.apps.find((a) => a.slug === "plain").devices, []);
	});
	it("never lets another publisher's app of the same name replace an installed one", async () => {
		const other = (await call(storeBase, "/api/v1/publishers", { method: "POST", json: { name: "someone", password: "correct horse battery", acceptPolicy: true } })).body.token;
		const m = manifest({ slug: "plain", name: "Plain", icon: "▫", version: "9.0.0" });
		const created = await call(storeBase, "/api/v1/apps/someone/plain/releases", { method: "POST", token: other, json: { manifest: m } });
		await call(storeBase, created.body.upload.url, { method: "PUT", token: other, body: await bundle({ version: "999999999999" }), headers: { "content-type": "application/gzip" } });
		const r = await apiCall(ada, "POST", "/api/apps", { id: "someone/plain" });
		assert.equal(r.status, 409);
		assert.match(r.json.error, /already has an app called Plain \(pub\/plain\)/);
		const apps = (await ada.request("GET", "/api/apps", { host: SHELL })).json.apps;
		assert.equal(apps.find((a) => a.slug === "plain").storeId, "pub/plain");
	});
	it("holds a grain's browser code to the app's declared hosts", () => {
		const none = grainPolicy([], "https://shell.test");
		assert.match(none, /connect-src 'self';/);
		assert.match(none, /img-src 'self' data: blob:;/);
		const some = grainPolicy(["api.example.com"], "https://shell.test");
		assert.match(some, /connect-src 'self' https:\/\/api\.example\.com https:\/\/\*\.api\.example\.com wss:\/\/api\.example\.com;/);
		assert.match(some, /font-src 'self' data:;/, "fonts never come from elsewhere");
		assert.match(some, /frame-ancestors https:\/\/shell\.test$/);
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
		assert.equal((await apiCall(ada, "POST", "/api/apps", { id: "pub/family" })).status, 200);
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
		assert.equal((await apiCall(ada, "POST", "/api/apps", { id: "pub/notes" })).status, 200);
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
		assert.match(caps, /Private to you/);
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
		// Hamstr's policy: framed by the shell only, and the page's code can reach
		// nothing beyond the grain itself (this app declares no hosts).
		const policy = r.headers["content-security-policy"];
		assert.match(policy, new RegExp(`frame-ancestors http://${SHELL.replace(/\./g, "\\.")}$`));
		assert.match(policy, /connect-src 'self';/);
		assert.match(policy, /script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;/);
		assert.match(policy, /font-src 'self' data:;/);
	});
	it("passes a grain's 304 through without dying", async () => {
		await enter(bob, board.id);
		const host = grainHost(board.id);
		const r = await bob.request("GET", "/not-modified", { host, headers: { cookie: bob.cookieHeader(host), "if-none-match": '"v1"' } });
		assert.equal(r.status, 304);
		assert.equal(r.headers.etag, '"v1"');
		const again = await bob.request("GET", "/notes", { host, headers: { cookie: bob.cookieHeader(host) } });
		assert.equal(again.status, 200, "the server is still up");
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
		// The app's own policy stays, next to Hamstr's: the browser enforces both.
		assert.match(r.headers["content-security-policy"], new RegExp(`^default-src 'self', default-src 'self'; .*frame-ancestors http://${SHELL.replace(/\./g, "\\.")}$`));
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
	it("moves every grain to a new release and ignores retired roles", async () => {
		await publish({ slug: "board", name: "Board", icon: "📌", version: "1.1.0", ...ROLES }, "dddddddddddd");
		const updates = await ada.request("GET", "/api/apps/updates", { host: SHELL });
		assert.equal(updates.json.updates.board.version, "1.1.0");
		const r = await apiCall(ada, "POST", "/api/apps", { id: "pub/board" });
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
	it("resets an item to empty, keeping the item, and puts the data back if that fails", async () => {
		const host = grainHost(board.id);
		const reset = (browser: any, body: any = { confirm: board.id }, headers: Record<string, string> = {}) => browser.request("POST", `/api/grains/${board.id}/reset`, { host: SHELL, headers: { ...ORIGIN, ...headers }, json: body });
		celld.data.set(host, "precious");
		// Refused before anything changes: not the owner, no confirmation, wrong item, cross-origin.
		assert.equal((await reset(ada)).status, 404);
		assert.equal((await reset(bob, {})).status, 400);
		assert.equal((await reset(bob, { confirm: "someone-else" })).status, 400);
		assert.equal((await reset(bob, { confirm: board.id }, { origin: "http://evil.test" })).status, 403);
		assert.equal(celld.data.get(host), "precious");

		// A reset that fails after the wipe puts the data back.
		celld.failActivate = host;
		const failed = await reset(bob);
		assert.equal(failed.status, 502);
		assert.match(failed.json.error, /put back as it was/);
		assert.equal(celld.data.get(host), "precious");
		assert.equal(celld.sites.has(host), true);

		const ok = await reset(bob);
		assert.equal(ok.status, 200, ok.text);
		assert.equal(celld.data.has(host), false, "the data is gone");
		assert.equal(celld.sites.has(host), true, "the item runs again, on its app's code");
		const grains = (await bob.request("GET", "/api/grains", { host: SHELL })).json.mine;
		assert.equal(grains.find((g) => g.id === board.id)?.title, "Kitchen board", "the item itself stays");
	});
	it("backs up any item and restores it, putting it back if a restore fails", async () => {
		const host = grainHost(board.id);
		const upload = (browser, path, body, headers = {}) =>
			browser.request(path.endsWith("/import") ? "POST" : "PUT", path, { host: SHELL, headers: { ...ORIGIN, "content-type": "application/octet-stream", ...headers }, body });
		celld.data.set(host, "version one");
		const down = await bob.request("GET", `/api/grains/${board.id}/backup`, { host: SHELL });
		assert.equal(down.status, 200, down.text);
		assert.match(down.headers["content-disposition"], /^attachment; filename="Kitchen board \d{4}-\d\d-\d\d\.hamstr-backup"/);
		const [head, ...rest] = down.text.trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual([head.type, head.app, head.appVersion, head.title], ["hamstr-backup", "board", "1.1.0", "Kitchen board"]);
		assert.deepEqual(rest.map((l) => l.type), ["celld-dump", "note", "end"]);
		assert.equal((await ada.request("GET", `/api/grains/${board.id}/backup`, { host: SHELL })).status, 404, "owner only");
		assert.equal((await bob.request("GET", `/api/grains/${board.id}/backup`, { host: SHELL, headers: { "sec-fetch-site": "cross-site" } })).status, 403);

		celld.data.set(host, "changed later");
		const r = await upload(bob, `/api/grains/${board.id}/backup`, down.text);
		assert.equal(r.status, 200, r.text);
		assert.equal(celld.data.get(host), "version one");

		// Refused before anything changes.
		const swap = (patch) => [JSON.stringify({ ...head, ...patch }), ...down.text.trim().split("\n").slice(1)].join("\n");
		assert.equal((await upload(bob, `/api/grains/${board.id}/backup`, swap({ appVersion: "9.0.0" }))).status, 409, "made by a newer app");
		assert.match((await upload(bob, `/api/grains/${board.id}/backup`, swap({ app: "plain", appName: "Plain" }))).json.error, /backup of Plain, not Board/);
		assert.equal((await upload(bob, `/api/grains/${board.id}/backup`, "hello\n")).status, 422);
		assert.equal((await upload(ada, `/api/grains/${board.id}/backup`, down.text)).status, 404, "owner only");
		assert.equal((await upload(bob, `/api/grains/${board.id}/backup`, down.text, { origin: "http://evil.test" })).status, 403);
		assert.equal((await upload(bob, `/api/grains/${board.id}/backup`, down.text, { "content-type": "text/plain" })).status, 415);
		assert.equal(celld.data.get(host), "version one");

		// A restore that fails half-way puts the item back.
		celld.data.set(host, "current");
		celld.failRestore = host;
		const failed = await upload(bob, `/api/grains/${board.id}/backup`, down.text);
		assert.equal(failed.status, 422);
		assert.match(failed.json.error, /put back as it was/);
		assert.equal(celld.data.get(host), "current");

		// Importing makes a new item from the backup.
		const made = await upload(bob, "/api/apps/board/import", down.text);
		assert.equal(made.status, 201, made.text);
		assert.equal(made.json.grain.title, "Kitchen board");
		assert.notEqual(made.json.grain.id, board.id);
		assert.equal(celld.data.get(grainHost(made.json.grain.id)), "version one");
		const before = celld.sites.size;
		assert.equal((await upload(bob, "/api/apps/plain/import", down.text)).status, 422);
		assert.equal(celld.sites.size, before, "a refused import leaves no grain behind");
		await apiCall(bob, "POST", `/api/grains/${made.json.grain.id}/trash`, {});
		assert.equal((await apiCall(bob, "DELETE", `/api/grains/${made.json.grain.id}`)).status, 200);
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
