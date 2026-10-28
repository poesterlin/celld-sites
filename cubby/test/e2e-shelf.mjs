// End-to-end: store -> shelf UI API -> local celld dev node.
//
//   node cubby/test/e2e-shelf.mjs
//
// Starts a throwaway store, publishes a tiny app, starts the shelf (in-process)
// and a celld dev node, signs in, installs, opens and removes the app. No
// Docker, no production state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Node } from "../../tests/harness.mjs";
import { createStore } from "../server.mjs";
import { createShelf } from "../shelf.mjs";
import { bundle, call, manifest } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "cubby-shelf-e2e-"));
const store = createStore({ dataDir: join(dir, "store"), rateLimit: false, logging: false });
const node = new Node(Number(process.env.TEST_INSTALL_PORT ?? 8782));
try {
	const address = await store.listen(0, "127.0.0.1");
	const storeUrl = `http://127.0.0.1:${address.port}`;
	const reg = await call(storeUrl, "/api/v1/publishers", {
		method: "POST",
		json: { name: "shelf", password: "correct horse battery" },
	});
	assert.equal(reg.status, 201, reg.text);
	const token = reg.body.token;
	const created = await call(storeUrl, "/api/v1/apps/hello/releases", {
		method: "POST",
		token,
		json: { manifest: manifest({ slug: "hello", name: "Hello", version: "1.0.0" }) },
	});
	assert.equal(created.status, 201, created.text);
	const bytes = await bundle({ files: { "index.html": "<h1>hello shelf</h1>" } });
	const uploaded = await call(storeUrl, created.body.upload.url, {
		method: "PUT",
		token,
		body: bytes,
		headers: { "content-type": "application/gzip" },
	});
	assert.equal(uploaded.status, 201, uploaded.text);

	await node.start();
	const shelf = createShelf({
		port: 0,
		dataDir: join(dir, "shelf"),
		store: storeUrl,
		storePublic: storeUrl,
		celldApi: `http://127.0.0.1:${node.port}`,
		adminToken: node.adminToken,
		adminHost: "admin.internal",
		appDomain: "example.com",
		password: "shelf-password",
		secret: "shelf-secret",
		rateLimit: false,
		logging: false,
	});
	const shelfAddress = await shelf.listen(0, "127.0.0.1");
	const base = `http://127.0.0.1:${shelfAddress.port}`;
	const login = await fetch(`${base}/login`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "password=shelf-password",
	});
	assert.equal(login.status, 303);
	const cookie = login.headers.get("set-cookie").split(";")[0];
	const api = async (path, options = {}) => {
		const res = await fetch(`${base}${path}`, {
			...options,
			headers: { cookie, "content-type": "application/json", ...(options.headers ?? {}) },
		});
		return { status: res.status, body: await res.json() };
	};
	const install = await api("/api/install", {
		method: "POST",
		body: JSON.stringify({ slug: "hello", host: "demo-shelf.test", allowEgress: false }),
	});
	assert.equal(install.status, 200, JSON.stringify(install.body));
	const page = await node.request("GET", "/", { host: "demo-shelf.test" });
	assert.equal(page.status, 200);
	assert.match(page.text, /hello shelf/);
	const installed = await api("/api/installed");
	assert.equal(installed.body.installed[0].slug, "hello");
	const removed = await api("/api/remove", {
		method: "POST",
		body: JSON.stringify({ host: "demo-shelf.test", confirm: "demo-shelf.test" }),
	});
	assert.equal(removed.status, 200, JSON.stringify(removed.body));
	assert.equal((await node.request("GET", "/", { host: "demo-shelf.test" })).status, 404);
	console.log("shelf e2e: publish -> login -> install -> open -> remove — OK");
	await shelf.close();
} finally {
	await node.stop();
	await store.close();
	rmSync(dir, { recursive: true, force: true });
}
