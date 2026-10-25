// API validation for celld-sites, against a local celld dev node (never production).
// Run: npm test --prefix tools   (needs celld in ~/.local/bin and npm ci --prefix tools)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Node, project } from "./harness.mjs";

const fixtures = join(project, "tests/fixtures");
const node = new Node();
let worker; // activation result of the worker fixture
const W = "worker.test";
const site = (path, opts = {}) => node.request(opts.method ?? "GET", path, { host: opts.host ?? W, headers: opts.headers, body: opts.body });
const obj = async (cls, name, method, args = [], host = W) =>
	(await site(`/obj?class=${encodeURIComponent(cls)}&name=${encodeURIComponent(name)}&method=${encodeURIComponent(method)}&args=${encodeURIComponent(JSON.stringify(args))}`, { host })).json();

before(async () => {
	await node.start();
	worker = node.deploy(join(fixtures, "worker"), W);
	node.deploy(join(fixtures, "spa"), "spa.test");
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
			["PUT", "/asset?version=aaaaaaaaaaaa&path=x"],
			["PUT", "/code?version=aaaaaaaaaaaa"],
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
	it("validates asset uploads", async () => {
		const put = (q, opts) => node.admin("PUT", `/asset?${q}`, { body: "x", ...opts });
		assert.equal((await put("version=nothex&path=a")).status, 400);
		assert.equal((await put("version=aaaaaaaaaaaa&path=")).status, 400);
		assert.equal((await put("version=aaaaaaaaaaaa&path=/abs")).status, 400);
		assert.equal((await put(`version=aaaaaaaaaaaa&path=${"a".repeat(401)}`)).status, 400);
		assert.equal((await put("version=aaaaaaaaaaaa&path=a", { chunked: true })).status, 411);
		assert.equal(node.adminUpload("PUT", "/asset?version=aaaaaaaaaaaa&path=big.bin", 20 * 1024 * 1024 + 1), 413);
		assert.equal((await put("version=aaaaaaaaaaaa&path=ok.txt")).status, 200);
	});
	it("validates code uploads and requires every listed file", async () => {
		const put = (body) => node.admin("PUT", "/code?version=aaaaaaaaaaaa", { body, headers: { "content-type": "application/json" } });
		assert.equal((await put("{not json")).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", assets: "nope" })).status, 400);
		assert.equal((await put({ compatibilityDate: "2026-10-01", assets: [], notFound: "maybe" })).status, 400);
		const missing = await put({ compatibilityDate: "2026-10-01", assets: ["ok.txt", "missing.txt"] });
		assert.equal(missing.status, 409);
		assert.match(missing.json().error, /missing 1 files/);
		assert.equal((await put({ compatibilityDate: "2026-10-01", assets: ["ok.txt"] })).status, 200);
		assert.equal(node.adminUpload("PUT", "/code?version=bbbbbbbbbbbb", 16 * 1024 * 1024 + 1), 413);
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
		assert.equal((await node.admin("PUT", "/asset?version=eeeeeeeeeeee&path=x.txt", { body: "x" })).status, 200);
		const code = { compatibilityDate: "2026-10-01", assets: ["x.txt"] };
		assert.equal((await node.admin("PUT", "/code?version=eeeeeeeeeeee", { body: code, headers: { "content-type": "application/json" } })).status, 200);
		const r = (await node.admin("POST", "/prune?keep=0")).json();
		assert.ok(r.deleted.includes("eeeeeeeeeeee"));
		assert.ok(!r.deleted.includes(worker.version));
		assert.equal((await site("/about")).status, 200);
		assert.equal((await node.admin("POST", `/activate?host=${W}&version=eeeeeeeeeeee`)).status, 404, "pruned versions can't be activated");
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
	it("refuses an invalid notFound option", () => {
		const dir = copy();
		writeFileSync(join(dir, "celld.json"), JSON.stringify({ assets: "public", notFound: "maybe" }));
		const r = pack(dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(r.ok, false);
		assert.match(r.error, /notFound/);
	});
});
