import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createShelf } from "../shelf.mjs";

const dir = mkdtempSync(join(tmpdir(), "cubby-shelf-test-"));
let shelf;
let base;

before(async () => {
	shelf = createShelf({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		store: "http://127.0.0.1:9",
		celldApi: "http://127.0.0.1:9",
		adminToken: "admin",
		password: "correct horse battery",
		secret: "test-secret",
		rateLimit: false,
		logging: false,
	});
	const address = await shelf.listen(0, "127.0.0.1");
	base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	await shelf.close();
	rmSync(dir, { recursive: true, force: true });
});

async function login() {
	const res = await fetch(`${base}/login`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "password=correct horse battery",
	});
	assert.equal(res.status, 303);
	return res.headers.get("set-cookie").split(";")[0];
}

const rawStatus = (path, headers) =>
	new Promise((resolvePromise, rejectPromise) => {
		const req = httpRequest({ hostname: "127.0.0.1", port: new URL(base).port, path, headers }, (res) => {
			res.resume();
			res.on("end", () => resolvePromise(res.statusCode));
		});
		req.on("error", rejectPromise);
		req.end();
	});

describe("shelf sessions", () => {
	it("survives a malformed Host header", async () => {
		assert.equal(await rawStatus("/api/health", { Host: "cubby.localhost:abc" }), 200);
		assert.equal((await fetch(`${base}/api/health`)).status, 200);
	});
	it("revokes the session on logout, not just the cookie", async () => {
		const cookie = await login();
		assert.equal((await fetch(`${base}/api/config`, { headers: { cookie } })).status, 200);
		const out = await fetch(`${base}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
		assert.equal(out.status, 303);
		assert.equal((await fetch(`${base}/api/config`, { headers: { cookie } })).status, 401);
	});
	it("rejects a cross-origin logout", async () => {
		const cookie = await login();
		const res = await fetch(`${base}/logout`, {
			method: "POST",
			redirect: "manual",
			headers: { cookie, origin: "https://evil.test" },
		});
		assert.equal(res.status, 403);
	});
	it("answers malformed percent-encoding with 400, not 500", async () => {
		const cookie = await login();
		const res = await fetch(`${base}/api/apps/%zz`, { headers: { cookie } });
		assert.equal(res.status, 400);
	});
});
