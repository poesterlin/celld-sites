// API validation for celld-sites, against a local celld dev node (never production).
// Run: npm test --prefix tools   (needs celld in ~/.local/bin and npm ci --prefix tools)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Node, project, sha256 } from "./harness.mjs";

const fixtures = join(project, "tests/fixtures");
const node = new Node();
let worker; // activation result of the worker fixture
let spa; // activation result of the spa fixture
const W = "worker.test";
const site = (path, opts = {}) => node.request(opts.method ?? "GET", path, { host: opts.host ?? W, headers: opts.headers, body: opts.body });
const obj = async (cls, name, method, args = [], host = W) =>
	(await site(`/obj?class=${encodeURIComponent(cls)}&name=${encodeURIComponent(name)}&method=${encodeURIComponent(method)}&args=${encodeURIComponent(JSON.stringify(args))}`, { host })).json();

before(async () => {
	await node.start();
	worker = node.deploy(join(fixtures, "worker"), W);
	spa = node.deploy(join(fixtures, "spa"), "spa.test");
	node.deploy(join(fixtures, "static"), "static.test");
});
after(async () => node.stop());

describe("admin API: authentication", () => {
	it("refuses requests without a token or with a wrong one", async () => {
		assert.equal((await node.admin("GET", "/overview", { token: null })).status, 403);
		assert.equal((await node.admin("GET", "/overview", { token: "wrong" })).status, 403);
	});
	it("lets the read token read, and only read", async () => {
		assert.equal((await node.admin("GET", "/overview", { token: "read" })).status, 200);
		// celld dev has no fixed operator port, so node state is unavailable here (503, not 403).
		const state = await node.admin("GET", "/state", { token: "read" });
		assert.equal(state.status, 503);
		assert.match(state.json().error, /not available/);
		assert.equal((await node.admin("GET", "/state", { token: null })).status, 403);
		for (const [method, path] of [
			["POST", "/activate?host=x.test&version=aaaaaaaaaaaa"],
			["POST", "/prune?keep=1"],
			["POST", "/call?host=worker.test&class=Kv&name=x&method=get"],
			["PUT", "/alias?host=a.test&site=worker.test"],
			["PUT", `/blob?hash=${sha256("x")}`],
			["POST", "/blobs/missing"],
			["PUT", "/code?version=aaaaaaaaaaaa"],
			["DELETE", "/site?id=worker.test&confirm=worker.test"],
		]) {
			assert.equal((await node.admin(method, path, { token: "read", body: "[]" })).status, 403, `${method} ${path}`);
		}
	});
	it("answers 404 for unknown admin routes and wrong methods", async () => {
		assert.equal((await node.admin("GET", "/nope")).status, 404);
		assert.equal((await node.admin("POST", "/overview")).status, 404);
		assert.equal((await node.admin("DELETE", "/prune")).status, 404);
	});
	it("is only reachable on the admin hostname", async () => {
		const r = await site("/__admin/overview", { headers: { authorization: `Bearer ${node.adminToken}` } });
		assert.equal(r.status, 404);
		assert.equal(r.text, "worker fallback");
	});
});

describe("deploy: upload, code, activate", () => {
	it("deploys through the real tools and reports the version", () => {
		assert.equal(worker.host, W);
		assert.equal(worker.site, W);
		assert.match(worker.version, /^[a-f0-9]{12}$/);
		assert.equal(worker.assets, 5);
		assert.ok(worker.sourceBytes > 0);
	});
	it("gives an unchanged site the same version", () => {
		assert.equal(node.deploy(join(fixtures, "worker"), W).version, worker.version);
	});
	it("validates file uploads and checks their hash", async () => {
		const put = (hash, opts) => node.admin("PUT", `/blob?hash=${hash}`, { body: "x", ...opts });
		assert.equal((await put("nothex")).status, 400);
		assert.equal((await put(sha256("y"))).status, 400, "body must match the hash");
		assert.equal((await put(sha256("x"), { chunked: true })).status, 411);
		assert.equal(node.adminUpload("PUT", `/blob?hash=${"0".repeat(64)}`, 20 * 1024 * 1024 + 1), 413);
		assert.equal((await put(sha256("x"))).status, 200);
	});
	it("reports which files are missing", async () => {
		const missing = (body) => node.admin("POST", "/blobs/missing", { body, headers: { "content-type": "application/json" } });
		assert.equal((await missing("{not json")).status, 400);
		assert.equal((await missing(["nothex"])).status, 400);
		const r = await missing([sha256("x"), sha256("never uploaded"), sha256("never uploaded")]);
		assert.equal(r.status, 200);
		assert.deepEqual(r.json().missing, [sha256("never uploaded")]);
	});
	it("validates code uploads and requires every listed file", async () => {
		const put = (body) => node.admin("PUT", "/code?version=aaaaaaaaaaaa", { body, headers: { "content-type": "application/json" } });
		const ok = { "ok.txt": [sha256("x"), "text/plain"] };
		assert.equal((await put("{not json")).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: ["ok.txt"] })).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: { "ok.txt": ["nothex", "text/plain"] } })).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: { "/abs": ok["ok.txt"] } })).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: { ["a".repeat(401)]: ok["ok.txt"] } })).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: ok, notFound: "maybe" })).status, 400);
		assert.equal((await put({ compatibilityDate: "soon", files: ok })).status, 400);
		const missing = await put({ compatibilityDate: "2026-10-01", files: { ...ok, "missing.txt": [sha256("nope"), "text/plain"] } });
		assert.equal(missing.status, 409);
		assert.match(missing.json().error, /missing 1 files, e\.g\. missing\.txt/);
		assert.equal((await put({ compatibilityDate: "2026-10-01", files: ok })).status, 200);
		assert.equal(node.adminUpload("PUT", "/code?version=bbbbbbbbbbbb", 16 * 1024 * 1024 + 1), 413);
	});
	it("uploads only the files the router doesn't have yet", async () => {
		const copy = mkdtempSync(join(tmpdir(), "celld-api-dedupe-"));
		try {
			cpSync(join(fixtures, "worker"), copy, { recursive: true });
			writeFileSync(join(copy, "public/hello.txt"), "changed for dedupe\n");
			const bundle = node.pack(copy);
			const hashes = readdirSync(join(bundle, "blobs"));
			rmSync(bundle, { recursive: true, force: true });
			const r = await node.admin("POST", "/blobs/missing", { body: hashes, headers: { "content-type": "application/json" } });
			assert.deepEqual(r.json().missing, [sha256("changed for dedupe\n")], "only the changed file");
			const out = node.deploy(copy, "dedupe.test");
			assert.equal(out.assets, 5);
			assert.equal((await site("/hello.txt", { host: "dedupe.test" })).text, "changed for dedupe\n");
			assert.equal((await site("/about", { host: "dedupe.test" })).status, 200);
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});
	it("--if-new deploys a new site but leaves an existing one alone", async () => {
		const other = mkdtempSync(join(tmpdir(), "celld-api-ifnew-"));
		try {
			cpSync(join(fixtures, "static"), other, { recursive: true });
			writeFileSync(join(other, "public/index.html"), "changed\n");
			const fresh = node.deploy(other, "ifnew.test", "--if-new");
			assert.equal(fresh.skipped, undefined);
			assert.equal((await site("/", { host: "ifnew.test" })).text, "changed\n");
			const again = node.deploy(join(fixtures, "static"), "ifnew.test", "--if-new");
			assert.equal(again.skipped, true);
			assert.equal(again.version, fresh.version, "reports the version that stays active");
			assert.equal((await site("/", { host: "ifnew.test" })).text, "changed\n");
			const history = (await node.admin("GET", "/overview")).json().deploys.filter((d) => d.site === "ifnew.test");
			assert.equal(history.length, 1, "a skipped deploy adds no history");
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
	it("validates activation", async () => {
		assert.equal((await node.admin("POST", "/activate?host=Not_A_Host&version=aaaaaaaaaaaa")).status, 400);
		assert.equal((await node.admin("POST", `/activate?host=${W}&version=cccccccccccc`)).status, 404);
	});
	it("switches versions atomically and rolls back", async () => {
		assert.equal((await node.admin("POST", "/activate?host=staged.test&version=aaaaaaaaaaaa")).status, 200);
		assert.equal((await site("/ok.txt", { host: "staged.test" })).text, "x");
		assert.equal((await site("/hello.txt", { host: "staged.test" })).status, 404);
		assert.equal((await node.admin("POST", `/activate?host=staged.test&version=${worker.version}`)).status, 200);
		assert.equal((await site("/hello.txt", { host: "staged.test" })).text, "hello from assets\n");
		assert.equal((await node.admin("POST", "/activate?host=staged.test&version=aaaaaaaaaaaa")).status, 200);
		assert.equal((await site("/ok.txt", { host: "staged.test" })).text, "x");
	});
});

describe("routing", () => {
	it("serves static files first, with clean URLs", async () => {
		assert.equal((await site("/")).text, "<h1>index</h1>\n");
		assert.equal((await site("/about")).text, "<h1>about</h1>\n");
		assert.equal((await site("/about.html")).text, "<h1>about</h1>\n");
		assert.equal((await site("/docs")).text, "<h1>docs</h1>\n");
		assert.equal((await site("/docs/")).text, "<h1>docs</h1>\n");
		assert.equal((await site("/%61bout")).text, "<h1>about</h1>\n");
	});
	it("sets content types and cache headers", async () => {
		const hashed = await site("/assets/app-Ab12Cd34.js");
		assert.equal(hashed.headers["cache-control"], "public, immutable, max-age=31536000");
		assert.match(hashed.headers["content-type"], /^text\/javascript/);
		const plain = await site("/hello.txt");
		assert.equal(plain.headers["cache-control"], "no-cache");
		assert.match(plain.headers["content-type"], /^text\/plain/);
	});
	it("answers HEAD without a body", async () => {
		const r = await site("/about", { method: "HEAD" });
		assert.equal(r.status, 200);
		assert.equal(r.text, "");
	});
	it("sends everything else to the worker", async () => {
		assert.equal((await site("/about", { method: "POST", body: "x" })).text, "worker fallback");
		assert.equal((await site("/no-such-path")).text, "worker fallback");
		assert.ok((await site("/%E0%A4%A")).status < 500, "malformed escapes must not crash routing");
	});
	it("hands the worker the browser's scheme behind the proxy", async () => {
		assert.match((await site("/echo")).json().url, /^http:\/\/worker\.test\//);
		assert.match((await site("/echo", { headers: { "x-forwarded-proto": "https" } })).json().url, /^https:\/\/worker\.test\//);
	});
	it("answers unknown hostnames with 404", async () => {
		const r = await site("/", { host: "nobody.test" });
		assert.equal(r.status, 404);
		assert.match(r.text, /No site for nobody\.test/);
	});
	it("SPA fallback answers page navigations only", async () => {
		const nav = await site("/some/route", { host: "spa.test", headers: { accept: "text/html,application/xhtml+xml" } });
		assert.equal(nav.status, 200);
		assert.equal(nav.text, "<h1>spa shell</h1>\n");
		const script = await site("/missing.js", { host: "spa.test", headers: { accept: "*/*" } });
		assert.equal(script.status, 404);
		assert.equal(script.text, "<h1>spa 404</h1>\n");
		assert.equal((await site("/assets/app-Zz99Yy88.js", { host: "spa.test" })).status, 200);
	});
	it("static sites answer unknown paths with 404.html", async () => {
		const r = await site("/nope", { host: "static.test", headers: { accept: "text/html" } });
		assert.equal(r.status, 404);
		assert.equal(r.text, "<h1>static 404</h1>\n");
		assert.equal((await site("/", { host: "static.test" })).headers["cache-control"], "no-cache");
		const head = await site("/nope", { host: "static.test", method: "HEAD" });
		assert.equal(head.status, 404);
		assert.equal(head.text, "");
	});
});

describe("bindings: OBJECTS", () => {
	it("stores and reads data", async () => {
		assert.deepEqual(await obj("Kv", "store", "put", ["k", { a: [1, 2], b: "x" }]), { ok: true, result: true });
		assert.deepEqual(await obj("Kv", "store", "get", ["k"]), { ok: true, result: { a: [1, 2], b: "x" } });
	});
	it("keeps separate data per object name", async () => {
		assert.deepEqual(await obj("Kv", "other", "get", ["k"]), { ok: true, result: null });
	});
	it("passes plain data both ways", async () => {
		const args = [1, "two", { three: [3, null, true] }, [4.5]];
		assert.deepEqual((await obj("Kv", "x", "echo", args)).result, args);
	});
	it("rejects invalid references", async () => {
		for (const [cls, name, method] of [
			["1bad", "x", "get"],
			["Kv", "x", "not-an-identifier"],
			["Kv", "a".repeat(201), "get"],
			["Kv", "", "get"],
		]) {
			const r = await obj(cls, name, method);
			assert.equal(r.ok, false, `${cls}/${name.slice(0, 10)}/${method}`);
			assert.match(r.error, /bad object reference/);
		}
	});
	it("reports errors from the object", async () => {
		assert.match((await obj("Kv", "x", "boom")).error, /boom from the object/);
		assert.equal((await obj("Kv", "x", "missingMethod")).ok, false);
		assert.equal((await obj("Nope", "x", "get")).ok, false);
	});
	it("refuses values that are not plain data", async () => {
		assert.equal((await (await site("/clone")).json()).ok, false);
		assert.equal((await obj("Kv", "x", "fn")).ok, false);
	});
	it("stops a runaway object method and keeps the object usable", async () => {
		const r = await obj("Kv", "store", "spin");
		assert.equal(r.ok, false);
		assert.match(r.error, /CPU|limit|exceeded/i);
		assert.deepEqual((await obj("Kv", "store", "get", ["k"])).result, { a: [1, 2], b: "x" });
	});
});

describe("bindings: ASSETS, network, CPU", () => {
	it("serves the site's own files through ASSETS", async () => {
		assert.deepEqual((await (await site("/assets-binding")).json()).result, { status: 200, text: "hello from assets\n" });
		assert.equal((await (await site("/assets-binding-missing")).json()).result, 404);
	});
	it("blocks outbound network", async () => {
		const r = await (await site("/egress")).json();
		assert.equal(r.ok, false);
		assert.match(r.error, /not permitted/);
	});
	it("answers 504 when the site never responds, and keeps serving", async () => {
		const started = Date.now();
		const r = await site("/hang");
		assert.equal(r.status, 504);
		assert.match(r.text, /did not finish within 2 s/);
		assert.ok(Date.now() - started < 10_000);
		assert.equal((await site("/echo")).status, 200);
	});
	it("gives up on an object call that never finishes", async () => {
		const r = await obj("Kv", "x", "hang");
		assert.equal(r.ok, false);
		assert.match(r.error, /Kv\.hang did not finish within 1\.6 s/);
	});
	it("stops a runaway request and keeps serving", async () => {
		const r = await site("/spin");
		assert.equal(r.status, 500);
		assert.match(r.text, /CPU limit/);
		assert.equal((await site("/about")).status, 200);
		assert.equal((await site("/echo")).status, 200);
	});
});

describe("aliases", () => {
	it("serve a site, with its data, under another hostname", async () => {
		assert.equal((await node.admin("PUT", `/alias?host=alias.test&site=${W}`)).status, 200);
		assert.equal((await site("/about", { host: "alias.test" })).text, "<h1>about</h1>\n");
		assert.deepEqual((await obj("Kv", "store", "get", ["k"], "alias.test")).result, { a: [1, 2], b: "x" });
	});
	it("validate their arguments", async () => {
		assert.equal((await node.admin("PUT", `/alias?host=${W}&site=${W}`)).status, 400);
		assert.equal((await node.admin("PUT", "/alias?host=x.test&site=nobody.test")).status, 404);
		assert.equal((await node.admin("PUT", `/alias?host=static.test&site=${W}`)).status, 409);
		assert.equal((await node.admin("PUT", `/alias?host=admin.internal&site=${W}`)).status, 400);
		assert.equal((await node.admin("PUT", `/alias?host=Bad_Host&site=${W}`)).status, 400);
	});
	it("can be removed", async () => {
		assert.equal((await node.admin("DELETE", "/alias?host=alias.test")).status, 200);
		let status;
		for (let i = 0; i < 14; i++) {
			status = (await site("/about", { host: "alias.test" })).status;
			if (status === 404) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		assert.equal(status, 404, "alias still answers after 7 s");
	});
});

describe("admin object calls (seeding)", () => {
	const call = (q, body, token) => node.admin("POST", `/call?${q}`, { body, token, headers: { "content-type": "application/json" } });
	it("validates parameters and body", async () => {
		assert.equal((await call("host=worker.test&class=Kv&name=x", "[]")).status, 400);
		assert.equal((await call("host=worker.test&class=Kv&name=&method=get", "[]")).status, 400);
		assert.equal((await call("host=worker.test&class=Kv&name=x&method=get", "{not json")).status, 400);
		assert.equal((await call("host=worker.test&class=Kv&name=x&method=get", '{"a":1}')).status, 400);
		assert.equal((await call("host=nobody.test&class=Kv&name=x&method=get", "[]")).status, 404);
		assert.equal((await call("host=worker.test&class=Kv&name=x&method=get&version=dddddddddddd", "[]")).status, 404);
	});
	it("calls methods and returns their result", async () => {
		assert.equal((await call("host=worker.test&class=Kv&name=seeded&method=put", '["k", 42]')).status, 200);
		const r = await call("host=worker.test&class=Kv&name=seeded&method=get", '["k"]');
		assert.equal(r.status, 200);
		assert.equal(r.json().result, 42);
		assert.deepEqual((await obj("Kv", "seeded", "get", ["k"])).result, 42, "visible to the site");
	});
	it("refuses versions that were not uploaded for the site", async () => {
		// A site that is not live (here: none at all) may only use versions uploaded for it.
		const r = await call(`host=never.test&class=Kv&name=x&method=get&version=${spa.version}`, '["k"]');
		assert.equal(r.status, 409);
		assert.match(r.json().error, /not uploaded for never\.test/);
	});
	it("seeds a site that is not live yet with its staged version, but never a live one", async () => {
		const copy = mkdtempSync(join(tmpdir(), "celld-api-staged-"));
		try {
			cpSync(join(fixtures, "worker"), copy, { recursive: true });
			writeFileSync(join(copy, "public/hello.txt"), "staged\n");
			const bundle = node.pack(copy);
			const version = await node.stage(bundle, "seed.test");
			assert.notEqual(version, worker.version);
			assert.equal((await call(`host=seed.test&class=Kv&name=seeded&method=put&version=${version}`, '["k", 1]')).status, 200);
			assert.equal((await site("/hello.txt", { host: "seed.test" })).status, 404, "staging does not activate");
			assert.equal((await node.admin("POST", `/activate?host=seed.test&version=${version}`)).status, 200);
			assert.equal((await call("host=seed.test&class=Kv&name=seeded&method=get", '["k"]')).json().result, 1, "seeded data is live");
			// A live site only runs its active version on its data.
			assert.equal(await node.stage(bundle, W), version);
			const live = await call(`host=worker.test&class=Kv&name=x&method=get&version=${version}`, '["k"]');
			assert.equal(live.status, 409);
			assert.match(live.json().error, /is live with version/);
			rmSync(bundle, { recursive: true, force: true });
			assert.equal((await call(`host=worker.test&class=Kv&name=x&method=get&version=${worker.version}`, '["k"]')).status, 200);
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});
	it("gives up on an object method that never finishes", async () => {
		const r = await call("host=worker.test&class=Kv&name=x&method=hang", "[]");
		assert.equal(r.status, 504);
		assert.match(r.json().error, /Kv\.hang did not finish within 1\.6 s/);
	});
	it("reports method errors", async () => {
		const r = await call("host=worker.test&class=Kv&name=x&method=boom", "[]");
		assert.equal(r.status, 500);
		assert.match(r.json().error, /boom from the object/);
	});
});

describe("overview and pruning", () => {
	it("lists sites, aliases, history, objects and versions", async () => {
		const o = (await node.admin("GET", "/overview", { token: "read" })).json();
		const w = o.sites.find((s) => s.id === W);
		assert.equal(w.version, worker.version);
		assert.ok(o.deploys.some((d) => d.site === W && d.version === worker.version));
		assert.ok(o.objects.some((x) => x.site === W && x.className === "Kv" && x.name === "store" && /^[a-f0-9]{64}$/.test(x.id)));
		assert.ok(o.versions.some((v) => v.version === worker.version && v.assets === 5));
	});
	it("prunes unreferenced versions and keeps every current one", async () => {
		assert.equal((await node.putVersion("eeeeeeeeeeee", { "x.txt": "x" })).status, 200);
		const r = (await node.admin("POST", "/prune?keep=0")).json();
		assert.ok(r.deleted.includes("eeeeeeeeeeee"));
		assert.ok(!r.deleted.includes(worker.version));
		assert.equal((await site("/about")).status, 200);
		assert.equal((await node.admin("POST", `/activate?host=${W}&version=eeeeeeeeeeee`)).status, 404, "pruned versions can't be activated");
	});
	it("keep=0 keeps only current versions and drops staged ones", async () => {
		for (const v of ["f1f1f1f1f1f1", "f2f2f2f2f2f2"]) {
			assert.equal((await node.putVersion(v, { "v.txt": v }, { host: "keep.test" })).status, 200);
		}
		assert.equal((await node.admin("POST", "/activate?host=keep.test&version=f1f1f1f1f1f1")).status, 200);
		assert.equal((await node.putVersion("f3f3f3f3f3f3", { "v.txt": "3" }, { host: "keep.test" })).status, 200);
		assert.equal((await node.admin("POST", "/activate?host=keep.test&version=f3f3f3f3f3f3")).status, 200);
		const two = (await node.admin("POST", "/prune?keep=2")).json();
		assert.ok(two.deleted.includes("f2f2f2f2f2f2"), "staged-only version is deleted");
		assert.ok(!two.deleted.includes("f1f1f1f1f1f1") && !two.deleted.includes("f3f3f3f3f3f3"), "keep=2 keeps both deployed versions");
		const zero = (await node.admin("POST", "/prune?keep=0")).json();
		assert.ok(zero.deleted.includes("f1f1f1f1f1f1"), "older version goes with keep=0");
		assert.ok(!zero.deleted.includes("f3f3f3f3f3f3"), "current version stays");
		assert.equal((await site("/v.txt", { host: "keep.test" })).text, "3");
		assert.equal(
			(await node.admin("POST", "/call?host=keep.test&class=Kv&name=x&method=get&version=f2f2f2f2f2f2", { body: "[]" })).status,
			404,
			"pruned staged version is gone",
		);
	});
});

describe("static files: validators, HEAD, cache", () => {
	it("sends an ETag and answers a matching If-None-Match with 304", async () => {
		const first = await site("/hello.txt");
		const etag = first.headers.etag;
		assert.equal(etag, `"${sha256("hello from assets\n").slice(0, 32)}"`, "the content hash");
		const again = await site("/hello.txt", { headers: { "if-none-match": etag } });
		assert.equal(again.status, 304);
		assert.equal(again.text, "");
		assert.equal(again.headers.etag, etag);
		assert.equal((await site("/hello.txt", { headers: { "if-none-match": `W/${etag}, "other"` } })).status, 304);
		assert.equal((await site("/hello.txt", { headers: { "if-none-match": '"other"' } })).status, 200);
	});
	it("keeps an unchanged file's ETag across versions, and changes it with the content", async () => {
		assert.equal((await site("/about")).headers.etag, (await site("/about", { host: "dedupe.test" })).headers.etag);
		assert.notEqual((await site("/hello.txt")).headers.etag, (await site("/hello.txt", { host: "dedupe.test" })).headers.etag);
		const a = (await site("/", { host: "static.test" })).headers.etag;
		const b = (await site("/", { host: "spa.test" })).headers.etag;
		assert.notEqual(a, b);
	});
	it("gives HEAD the content length", async () => {
		const get = await site("/hello.txt");
		const head = await site("/hello.txt", { method: "HEAD" });
		assert.equal(head.headers["content-length"], String(Buffer.byteLength(get.text)));
	});
	it("serves the same bytes from the memory cache", async () => {
		const texts = [];
		for (let i = 0; i < 4; i++) texts.push((await site("/hello.txt")).text);
		assert.deepEqual(texts, Array(4).fill("hello from assets\n"));
	});
	it("defaults immutable to the prefixes the build has, minus files that change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "celld-api-cache-"));
		try {
			const files = {
				"index.html": "home",
				"_nuxt/app.Ab12Cd34Ef.js": "js",
				"_nuxt/builds/latest.json": "{}",
				"assets/logo.png": "png",
			};
			for (const [path, body] of Object.entries(files)) {
				mkdirSync(join(dir, "public", dirname(path)), { recursive: true });
				writeFileSync(join(dir, "public", path), body);
			}
			writeFileSync(join(dir, "celld.json"), JSON.stringify({ assets: "public" }));
			node.deploy(dir, "cache.test");
			const cc = async (path) => (await site(path, { host: "cache.test" })).headers["cache-control"];
			assert.equal(await cc("/_nuxt/app.Ab12Cd34Ef.js"), "public, immutable, max-age=31536000");
			assert.equal(await cc("/_nuxt/builds/latest.json"), "no-cache", "Nuxt's build manifest changes per build");
			assert.equal(await cc("/assets/logo.png"), "no-cache", "assets/ without hashes is not immutable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pruning leftovers", () => {
	it("deletes files no version uses, once old enough", async () => {
		const lost = await node.putBlob("lost upload");
		const isStored = async (h) => (await node.admin("POST", "/blobs/missing", { body: [h], headers: { "content-type": "application/json" } })).json().missing.length === 0;
		await node.admin("POST", "/prune?keep=3");
		assert.ok(await isStored(lost), "a fresh upload may be a deploy in progress");
		assert.ok((await node.admin("POST", "/prune?keep=3&orphanAge=0")).json().blobsDeleted >= 1);
		assert.ok(!(await isStored(lost)));
		assert.ok(await isStored(sha256("hello from assets\n")), "files of stored versions stay");
		for (const host of [W, "spa.test", "static.test", "dedupe.test", "cache.test"]) {
			assert.equal((await site("/", { host })).status < 500, true);
		}
		assert.equal((await site("/hello.txt")).text, "hello from assets\n");
	});
	it("trims deploy history to the last 100 per site", async () => {
		for (let i = 0; i < 102; i++) {
			assert.equal((await node.admin("POST", `/activate?host=history.test&version=${worker.version}`)).status, 200);
		}
		const r = (await node.admin("POST", "/prune?keep=3")).json();
		assert.ok(r.historyDeleted >= 2);
		const history = (await node.admin("GET", "/overview")).json().deploys.filter((d) => d.site === "history.test");
		assert.equal(history.length, 100);
	});
});

describe("deleting a site", () => {
	const D = "del.test";
	before(async () => {
		node.deploy(join(fixtures, "worker"), D);
		assert.equal((await obj("Kv", "data", "put", ["k", "secret"], D)).ok, true);
		assert.equal((await node.admin("PUT", `/alias?host=delalias.test&site=${D}`)).status, 200);
	});
	it("validates the request", async () => {
		assert.equal((await node.admin("DELETE", `/site?id=${D}`)).status, 400, "needs confirm");
		assert.equal((await node.admin("DELETE", `/site?id=${D}&confirm=other.test`)).status, 400);
		assert.equal((await node.admin("DELETE", "/site?id=nobody.test&confirm=nobody.test")).status, 404);
		assert.equal((await node.admin("DELETE", "/site?id=delalias.test&confirm=delalias.test")).status, 409, "aliases are not sites");
		const r = await node.admin("DELETE", `/site?id=${D}&confirm=${D}`);
		assert.equal(r.status, 409, "refuses while aliases point at it");
		assert.match(r.json().error, /delalias\.test/);
		assert.equal((await site("/hello.txt", { host: D })).status, 200, "a refused delete changes nothing");
	});
	it("stops serving and deletes data, history and aliases", async () => {
		const r = await node.admin("DELETE", `/site?id=${D}&confirm=${D}&aliases=delete`);
		assert.equal(r.status, 200, r.text);
		const out = r.json();
		assert.deepEqual(out.aliases, ["delalias.test"]);
		assert.ok(out.objects >= 1);
		assert.ok(out.history >= 1);
		assert.deepEqual(out.errors, []);
		assert.equal((await site("/hello.txt", { host: D })).status, 404);
		assert.equal((await site("/hello.txt", { host: "delalias.test" })).status, 404);
		const o = (await node.admin("GET", "/overview")).json();
		assert.ok(!o.sites.some((s) => s.id === D));
		assert.ok(!o.deploys.some((d) => d.site === D));
		assert.ok(!o.objects.some((x) => x.site === D));
		assert.ok(!o.aliases.some((a) => a.site === D));
	});
	it("leaves a fresh, empty site when the id is deployed again", async () => {
		node.deploy(join(fixtures, "worker"), D);
		assert.equal((await obj("Kv", "data", "get", ["k"], D)).result, null);
	});
	it("leaves other sites alone", async () => {
		assert.equal((await obj("Kv", "store", "get", ["a"])).ok, true);
		assert.equal((await site("/hello.txt")).status, 200);
	});
});

describe("upgrade from per-version files (asset: keys)", () => {
	// The release before content-addressed files; its versions must keep working.
	const OLD_ROUTER = "dc2c5b9";
	let old;
	let oldSource;
	try {
		oldSource = execFileSync("git", ["-C", project, "show", `${OLD_ROUTER}:router/index.js`]).toString();
	} catch {}
	const legacy = { "index.html": "old home", "kept.txt": "same bytes" };
	before(async () => {
		if (!oldSource) return;
		old = await new Node(Number(process.env.TEST_PORT ?? 8799) + 1).start({ routerSource: oldSource });
		for (const [path, body] of Object.entries(legacy)) {
			assert.equal((await old.admin("PUT", `/asset?version=0dd0dd0dd0dd&path=${path}`, { body, headers: { "content-type": "text/plain" } })).status, 200);
		}
		const code = { compatibilityDate: "2026-10-01", assets: Object.keys(legacy), immutable: [] };
		assert.equal((await old.admin("PUT", "/code?version=0dd0dd0dd0dd", { body: code, headers: { "content-type": "application/json" } })).status, 200);
		assert.equal((await old.admin("POST", "/activate?host=legacy.test&version=0dd0dd0dd0dd")).status, 200);
		await old.restart();
	});
	after(async () => old?.stop());
	const get = (path) => old.request("GET", path, { host: "legacy.test" });

	it("still serves old-format versions", { skip: !oldSource && "old router not in git history" }, async () => {
		const r = await get("/kept.txt");
		assert.equal(r.status, 200);
		assert.equal(r.text, "same bytes");
		assert.equal(r.headers.etag, '"0dd0dd0dd0dd:kept.txt"');
		assert.equal((await get("/kept.txt")).text, "same bytes", "from the cache too");
		assert.equal((await old.admin("GET", "/overview")).json().versions.find((v) => v.version === "0dd0dd0dd0dd").assets, 2);
	});
	it("switches a version to blobs when re-uploaded, and prune drops its old files", { skip: !oldSource && "old router not in git history" }, async () => {
		assert.equal((await old.putVersion("0dd0dd0dd0dd", { "index.html": "old home", "kept.txt": "same bytes" })).status, 200);
		const r = (await old.admin("POST", "/prune?keep=3")).json();
		assert.equal(r.oldFilesDeleted, 2);
		assert.equal((await get("/kept.txt")).text, "same bytes");
		assert.equal((await get("/kept.txt")).headers.etag, `"${sha256("same bytes").slice(0, 32)}"`);
	});
});

describe("packer", () => {
	const pack = (dir) => {
		const out = mkdtempSync(join(tmpdir(), "pack-out-"));
		try {
			execFileSync("node", [join(project, "tools/pack.mjs"), dir, out], { stdio: ["ignore", "ignore", "pipe"], env: node.env });
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e.stderr.toString() };
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	};
	const copy = () => {
		const dir = mkdtempSync(join(tmpdir(), "pack-site-"));
		cpSync(join(fixtures, "static"), dir, { recursive: true });
		return dir;
	};
	it("refuses symlinks in the static directory", () => {
		const dir = copy();
		symlinkSync("/etc/hostname", join(dir, "public/leak.txt"));
		const r = pack(dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(r.ok, false);
		assert.match(r.error, /symlink/);
	});
	it("refuses files over 20 MiB", () => {
		const dir = copy();
		writeFileSync(join(dir, "public/big.bin"), Buffer.alloc(20 * 1024 * 1024 + 1));
		const r = pack(dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(r.ok, false);
		assert.match(r.error, /limit/);
	});
	it("takes the compatibility date from celld.json and checks it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "celld-api-compat-"));
		try {
			cpSync(join(fixtures, "static"), dir, { recursive: true });
			const bundle = node.pack(dir);
			const plain = JSON.parse(readFileSync(join(bundle, "code.json"), "utf8"));
			const plainVersion = readFileSync(join(bundle, "version"), "utf8");
			rmSync(bundle, { recursive: true, force: true });
			assert.equal(plain.compatibilityDate, "2026-10-01");
			writeFileSync(join(dir, "celld.json"), JSON.stringify({ assets: "public", immutable: [], compatibilityDate: "2026-06-01" }));
			const dated = node.pack(dir);
			assert.equal(JSON.parse(readFileSync(join(dated, "code.json"), "utf8")).compatibilityDate, "2026-06-01");
			assert.notEqual(readFileSync(join(dated, "version"), "utf8"), plainVersion, "the date is part of the version");
			rmSync(dated, { recursive: true, force: true });
			writeFileSync(join(dir, "celld.json"), JSON.stringify({ assets: "public", compatibilityDate: "June" }));
			assert.throws(() => node.pack(dir), /compatibilityDate must be YYYY-MM-DD/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("refuses an invalid notFound option", () => {
		const dir = copy();
		writeFileSync(join(dir, "celld.json"), JSON.stringify({ assets: "public", notFound: "maybe" }));
		const r = pack(dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(r.ok, false);
		assert.match(r.error, /notFound/);
	});
});
