// Security regression tests: the isolate boundary, per-site quotas and path
// handling, against local celld dev nodes. Never production.
// Run: npm test --prefix tools   (or: node --test tests/security.test.mjs)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Node } from "./harness.mjs";

const dir = mkdtempSync(join(tmpdir(), "celld-security-"));
const host = "guard.test";
const main = new Node(8781);
const quota = new Node(8782);
const flood = new Node(8783);

const site = (n, path, opts = {}) => n.request(opts.method ?? "GET", path, { host, headers: opts.headers, body: opts.body });
const obj = async (name, method = "get", args = [], n = quota) =>
	(await site(n, `/obj?name=${encodeURIComponent(name)}&method=${encodeURIComponent(method)}&args=${encodeURIComponent(JSON.stringify(args))}`)).json();

before(async () => {
	writeFileSync(
		join(dir, "worker.js"),
		`export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/ctx") {
			return Response.json({
				keys: Object.keys(ctx).sort(),
				frozen: Object.isFrozen(ctx),
				exports: typeof ctx.exports,
				props: typeof ctx.props,
			});
		}
		if (url.pathname === "/slow") {
			await new Promise((resolve) => setTimeout(resolve, 800));
			return new Response("slow\\n");
		}
		if (url.pathname === "/obj") {
			const name = url.searchParams.get("name");
			const method = url.searchParams.get("method") ?? "get";
			const args = JSON.parse(url.searchParams.get("args") ?? "[]");
			try {
				return Response.json({ ok: true, result: await env.OBJECTS.call("Box", name, method, ...args) });
			} catch (e) {
				return Response.json({ ok: false, error: String(e?.message ?? e) });
			}
		}
		return new Response("ok\\n");
	},
};
`,
	);
	writeFileSync(
		join(dir, "objects.js"),
		`import { DurableObject } from "cloudflare:workers";
export class Box extends DurableObject {
	get(n) {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
		this.ctx.storage.sql.exec("INSERT INTO t (v) VALUES (?)", n ?? 0);
		return { n: n ?? 0, rows: this.ctx.storage.sql.exec("SELECT count(*) AS c FROM t").toArray()[0].c };
	}
}
`,
	);
	writeFileSync(join(dir, "celld.json"), JSON.stringify({ worker: "worker.js", objects: "objects.js", check: false }));

	await main.start();
	process.env.TEST_SITE_MAX_OBJECTS = "3";
	process.env.TEST_SITE_MAX_INFLIGHT = "50";
	await quota.start();
	process.env.TEST_SITE_MAX_OBJECTS = "1000";
	process.env.TEST_SITE_MAX_INFLIGHT = "2";
	await flood.start();
	main.deploy(dir, host);
	quota.deploy(dir, host);
	flood.deploy(dir, host);
	const v = await main.putVersion("bbbbbbbbbbbb", { "index.html": "home\n" }, { host: "files.test" });
	assert.equal(v.status, 200);
	assert.equal((await main.admin("POST", "/activate?host=files.test&version=bbbbbbbbbbbb")).status, 200);
});

after(async () => {
	await main.stop();
	await quota.stop();
	await flood.stop();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.TEST_SITE_MAX_OBJECTS;
	delete process.env.TEST_SITE_MAX_INFLIGHT;
});

describe("isolate boundary", () => {
	it("gives the site a minimal request context, not the runtime's own", async () => {
		const r = await (await site(main, "/ctx")).json();
		assert.deepEqual(r.keys, ["abort", "passThroughOnException", "waitUntil"]);
		assert.equal(r.frozen, true);
		assert.equal(r.exports, "undefined");
		assert.equal(r.props, "undefined");
	});
	it("rejects an object reference whose KV key exceeds the byte limit", async () => {
		const name = "界".repeat(200); // 600 bytes in UTF-8, 200 UTF-16 units
		const j = await (await site(main, `/obj?name=${encodeURIComponent(name)}&method=get`)).json();
		assert.equal(j.ok, false);
		assert.match(j.error, /bad object reference/);
	});
	it("never serves the admin API on a site hostname, even with the admin token", async () => {
		const r = await site(main, "/__admin/overview", { headers: { authorization: `Bearer ${main.adminToken}` } });
		assert.equal(r.text, "ok\n");
		assert.doesNotMatch(r.text, /"sites"/);
	});
	it("answers path traversal attempts without leaking or crashing", async () => {
		for (const p of ["/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/a/../../b"]) {
			const r = await main.request("GET", p, { host: "files.test" });
			assert.equal(r.status, 404, p);
			assert.doesNotMatch(r.text, /root:|home/);
		}
		assert.equal((await main.request("GET", "/", { host: "files.test" })).text, "home\n");
	});
});

describe("deploy invariants", () => {
	it("refuses to rewrite an existing version with different content", async () => {
		assert.equal((await main.putVersion("dddddddddddd", { "a.txt": "a" })).status, 200);
		const changed = await main.putVersion("dddddddddddd", { "a.txt": "b" });
		assert.equal(changed.status, 409);
		assert.match(changed.json().error, /already exists with different content/);
		const same = await main.putVersion("dddddddddddd", { "a.txt": "a" });
		assert.equal(same.status, 200);
		assert.equal(same.json().unchanged, true);
	});
	it("binds activation to the site a version was uploaded for", async () => {
		const v = await main.putVersion("cccccccccccc", { "x.txt": "x" });
		assert.equal(v.status, 200);
		const denied = await main.admin("POST", "/activate?host=inv.test&version=cccccccccccc");
		assert.equal(denied.status, 409);
		assert.match(denied.json().error, /not uploaded for inv\.test/);
		assert.equal((await main.admin("POST", "/stage?host=inv.test&version=cccccccccccc")).status, 200);
		assert.equal((await main.admin("POST", "/activate?host=inv.test&version=cccccccccccc")).status, 200);
		// The same code is not valid for another site's objects.
		assert.equal((await main.admin("POST", "/activate?host=other.test&version=cccccccccccc")).status, 409);
	});
	it("requires confirmation and whole numbers for prune", async () => {
		assert.equal((await main.admin("POST", "/prune")).status, 400);
		assert.equal((await main.admin("POST", "/prune?confirm=prune&keep=abc")).status, 400);
		assert.equal((await main.admin("POST", "/prune?confirm=prune&orphanAge=")).status, 400);
		assert.equal((await main.admin("POST", "/prune?confirm=prune&keep=3")).status, 200);
	});
	it("rejects the admin hostname as a site id", async () => {
		const r = await main.putVersion("eeeeeeeeeeee", { "x.txt": "1" }, { host: "admin.internal" });
		assert.equal(r.status, 400);
		assert.equal((await main.admin("POST", "/stage?host=admin.internal&version=dddddddddddd")).status, 400);
	});
	it("refuses deploy and activation through an alias", async () => {
		assert.equal((await main.admin("PUT", "/alias?host=vanity.test&site=files.test")).status, 200);
		const r = await main.putVersion("abababababab", { "a.txt": "a" }, { host: "vanity.test" });
		assert.equal(r.status, 409);
		assert.match(r.json().error, /is an alias/);
		assert.equal((await main.admin("POST", "/stage?host=vanity.test&version=cccccccccccc")).status, 409);
		assert.equal((await main.admin("POST", "/activate?host=vanity.test&version=cccccccccccc")).status, 409);
	});
	it("caps the versions staged for one site", async () => {
		for (let i = 1; i <= 20; i++) {
			const version = i.toString(16).padStart(12, "0");
			assert.equal((await main.putVersion(version, { "s.txt": "s" }, { host: "cap.test" })).status, 200, `stage ${i}`);
		}
		assert.equal((await main.putVersion("ffffffffffff", { "s.txt": "s" }, { host: "cap.test" })).status, 429);
		assert.equal((await main.admin("POST", "/stage?host=cap.test&version=cccccccccccc")).status, 429);
	});
});

describe("per-site quotas", () => {
	it("refuses a deploy that stores a path with a .. segment", async () => {
		const r = await main.putVersion("aaaaaaaaaaaa", { "../evil.txt": "x" });
		assert.equal(r.status, 400);
	});
	it("caps the objects one site may create, and keeps existing ones working", async () => {
		for (const name of ["a", "b", "c"]) assert.equal((await obj(name)).ok, true, name);
		const denied = await obj("d");
		assert.equal(denied.ok, false);
		assert.match(denied.error, /object quota/);
		assert.deepEqual((await obj("a", "get", [7])).result, { n: 7, rows: 2 });
	});
	it("holds the quota under concurrent first calls", async () => {
		const names = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"];
		const results = await Promise.all(names.map((name) => obj(name)));
		assert.deepEqual(results.filter((r) => r.ok), [], "no slot is left");
		for (const r of results) assert.match(r.error, /object quota/);
	});
	it("answers 503 above the in-flight limit and recovers", async () => {
		const results = await Promise.all(Array.from({ length: 6 }, () => site(flood, "/slow").then((r) => r.status)));
		assert.ok(results.includes(503), `statuses: ${results.join(",")}`);
		assert.ok(results.includes(200), `statuses: ${results.join(",")}`);
		// Slots are released even for the requests that were served.
		await new Promise((r) => setTimeout(r, 1200));
		assert.equal((await site(flood, "/")).status, 200);
	});
});
