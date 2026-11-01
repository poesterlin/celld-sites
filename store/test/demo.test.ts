import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createStore } from "../server.ts";
import { bundle, call, manifest } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "store-demo-test-"));
const events = [];
// What the fake demo node says about its memory.
const nodeLoad = { pressured: false, memory_headroom: true, draining: false };
const PLAIN_OK = new Set(["/__admin/prune", "/__admin/activate", "/__admin/site", "/__admin/blob", "/__admin/code"]);
// What the fake demo node answers for a path: [status, json body].
function fakeAnswer(pathname: string, body: string): [number, string] {
	if (pathname === "/__admin/blobs/missing") return [200, JSON.stringify({ missing: JSON.parse(body || "[]") })];
	if (pathname === "/__admin/state") return [200, JSON.stringify({ node_load: nodeLoad })];
	if (pathname === "/__admin/check") return [200, JSON.stringify({ ok: true, status: 200, ms: 1, path: "/" })];
	return PLAIN_OK.has(pathname) ? [200, "{}"] : [404, "{}"];
}
const fake = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		events.push({ method: req.method, url: req.url, body });
		res.setHeader("content-type", "application/json");
		const [status, payload] = fakeAnswer(new URL(req.url, "http://fake").pathname, body);
		res.statusCode = status;
		res.end(payload);
	});
});
let demoBase;
let store;
let token;

before(async () => {
	await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
	demoBase = `http://127.0.0.1:${(fake.address() as import("node:net").AddressInfo).port}`;
	store = createStore({
		dataDir: join(dir, "store"),
		rateLimit: false,
		logging: false,
		demoApi: demoBase,
		demoToken: "demo-token",
		demoHost: "demo-admin.internal",
		demoDomain: "demo.test",
		demoTtl: 600,
		demoMax: 2,
		demoPerHour: 10,
		demoStateMs: 0,
	});
	const address = await store.listen(0, "127.0.0.1");
	const base = `http://127.0.0.1:${address.port}`;
	const reg = await call(base, "/api/v1/publishers", { method: "POST", json: { name: "demo", password: "correct horse battery", acceptPolicy: true } });
	token = reg.body.token;
	const created = await call(base, "/api/v1/apps/demo/hello/releases", {
		method: "POST",
		token,
		json: { manifest: manifest({ slug: "hello", name: "Hello", version: "1.0.0" }) },
	});
	const bytes = await bundle({ files: { "index.html": "<h1>demo</h1>" } });
	await call(base, created.body.upload.url, { method: "PUT", token, body: bytes, headers: { "content-type": "application/gzip" } });
	store.base = base;
});

after(async () => {
	await store.close();
	await new Promise((resolve) => fake.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

describe("demo sessions", () => {
	it("deploys a throwaway site on the demo node and removes it", async () => {
		const detail = await call(store.base, "/api/v1/apps/demo/hello");
		assert.equal(detail.body.demo.available, true);
		const created = await call(store.base, "/api/v1/apps/demo/hello/demo", { method: "POST", json: {} });
		assert.equal(created.status, 201, created.text);
		assert.match(created.body.url, /^https:\/\/demo-[a-f0-9]{12}\.demo\.test$/);
		assert.equal(created.body.version, "1.0.0");
		assert.ok(created.body.endToken, "the creator gets an end token");
		const code = events.find((e) => e.method === "PUT" && e.url.startsWith("/__admin/code"));
		assert.ok(code, "the bundle was uploaded as code");
		assert.match(code.url, /host=demo-[a-f0-9]{12}\.demo\.test/);
		assert.ok(events.some((e) => e.method === "POST" && e.url.startsWith("/__admin/check")));
		assert.ok(events.some((e) => e.method === "POST" && e.url.startsWith("/__admin/activate")));

		const got = await call(store.base, `/api/v1/demos/${created.body.id}`);
		assert.equal(got.status, 200);
		assert.equal(got.body.status, "running");
		const denied = await call(store.base, `/api/v1/demos/${created.body.id}`, { method: "DELETE" });
		assert.equal(denied.status, 403);
		const deleted = await call(store.base, `/api/v1/demos/${created.body.id}`, {
			method: "DELETE",
			headers: { "x-demo-token": created.body.endToken },
		});
		assert.equal(deleted.status, 200);
		assert.ok(events.some((e) => e.method === "DELETE" && e.url.startsWith("/__admin/site")));
		assert.equal((await call(store.base, `/api/v1/demos/${created.body.id}`)).body.status, "expired");
	});
	it("hides Try it while every slot is taken", async () => {
		const started = [];
		for (let i = 0; i < 2; i++) started.push((await call(store.base, "/api/v1/apps/demo/hello/demo", { method: "POST", json: {} })).body);
		const detail = await call(store.base, "/api/v1/apps/demo/hello");
		assert.equal(detail.body.demo.available, false);
		assert.equal(detail.body.demo.busy, true);
		assert.match(detail.body.demo.reason, /slots are busy/);
		assert.equal((await call(store.base, "/api/v1/apps/demo/hello/demo", { method: "POST", json: {} })).status, 503);
		for (const demo of started) await call(store.base, `/api/v1/demos/${demo.id}`, { method: "DELETE", headers: { "x-demo-token": demo.endToken } });
		assert.equal((await call(store.base, "/api/v1/apps/demo/hello")).body.demo.available, true, "back once slots free up");
	});
	it("hides Try it while the demo node is short of memory", async () => {
		nodeLoad.pressured = true;
		try {
			const detail = await call(store.base, "/api/v1/apps/demo/hello");
			assert.equal(detail.body.demo.available, false);
			assert.match(detail.body.demo.reason, /demo server is busy/);
			assert.equal((await call(store.base, "/api/v1/apps/demo/hello/demo", { method: "POST", json: {} })).status, 503);
		} finally {
			nodeLoad.pressured = false;
		}
		assert.equal((await call(store.base, "/api/v1/apps/demo/hello")).body.demo.available, true);
	});
	it("does not demo an app that needs network access", async () => {
		const created = await call(store.base, "/api/v1/apps/demo/net/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "net", name: "Net", version: "1.0.0", egress: ["api.example.com"] }) },
		});
		const bytes = await bundle();
		await call(store.base, created.body.upload.url, { method: "PUT", token, body: bytes, headers: { "content-type": "application/gzip" } });
		const detail = await call(store.base, "/api/v1/apps/demo/net");
		assert.equal(detail.body.demo.available, false);
		assert.match(detail.body.demo.reason, /network/);
		assert.equal((await call(store.base, "/api/v1/apps/demo/net/demo", { method: "POST", json: {} })).status, 409);
	});
});
