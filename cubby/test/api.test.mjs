import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createStore } from "../server.mjs";
import { bundle, call, codeRecord, manifest, sha256, tgz } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "cubby-api-test-"));
const store = createStore({ dataDir: dir, adminToken: "admin-secret", rateLimit: false, logging: false, requireReview: false });
const address = await store.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${address.port}`;
const admin = { "x-admin-token": "admin-secret" };
let token;

after(async () => {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
});

async function register(name) {
	const res = await call(base, "/api/v1/publishers", { method: "POST", json: { name, password: "correct horse battery" } });
	assert.equal(res.status, 201, res.text);
	return res.body.token;
}

async function publish(slug, version, over = {}, blob = null) {
	const created = await call(base, `/api/v1/apps/${slug}/releases`, {
		method: "POST",
		token,
		json: { manifest: manifest({ slug, name: slug, version, ...over }) },
	});
	if (created.status !== 201) return created;
	const bytes = blob ?? (await bundle({ version: "aaaaaaaaaaaa", files: { "index.html": `<h1>${slug}</h1>` } }));
	const uploaded = await call(base, created.body.upload.url, {
		method: "PUT",
		token,
		body: bytes,
		headers: { "content-type": "application/gzip", "x-content-sha256": sha256(bytes) },
	});
	return { ...created, uploaded, bytes };
}

const rawStatus = (path, headers) =>
	new Promise((resolvePromise, rejectPromise) => {
		const req = httpRequest({ hostname: "127.0.0.1", port: address.port, path, headers }, (res) => {
			res.resume();
			res.on("end", () => resolvePromise(res.statusCode));
		});
		req.on("error", rejectPromise);
		req.end();
	});

describe("store API", () => {
	it("survives a malformed Host header", async () => {
		assert.equal(await rawStatus("/api/health", { Host: "cubby.localhost:abc" }), 200);
		assert.equal((await call(base, "/api/health")).status, 200);
	});
	it("creates a publisher and refuses anonymous publishing", async () => {
		token = await register("tester");
		assert.match(token, /^cub_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
		const denied = await call(base, "/api/v1/apps/nope/releases", { method: "POST", json: { manifest: manifest() } });
		assert.equal(denied.status, 401);
		const dup = await call(base, "/api/v1/publishers", { method: "POST", json: { name: "tester", password: "another password" } });
		assert.equal(dup.status, 409);
	});

	it("publishes, lists, reads and downloads a bundle", async () => {
		const result = await publish("hello", "1.0.0");
		assert.equal(result.status, 201, JSON.stringify(result.body));
		assert.equal(result.uploaded.status, 201);
		assert.equal(result.uploaded.body.release.status, "published");

		const list = await call(base, "/api/v1/apps");
		assert.equal(list.status, 200);
		assert.equal(list.body.total, 1);
		assert.equal(list.body.apps[0].slug, "hello");
		assert.equal(list.body.apps[0].downloads, 0);

		const detail = await call(base, "/api/v1/apps/hello");
		assert.equal(detail.status, 200);
		assert.equal(detail.body.releases.length, 1);
		assert.equal(detail.body.releases[0].manifest.egress.length, 0);

		const dl = await fetch(`${base}/api/v1/apps/hello/releases/1.0.0/download`);
		assert.equal(dl.status, 200);
		const bytes = Buffer.from(await dl.arrayBuffer());
		assert.equal(dl.headers.get("x-cubby-sha256"), sha256(bytes));
		assert.deepEqual(bytes, result.bytes);
		const afterOne = await call(base, "/api/v1/apps/hello");
		assert.equal(afterOne.body.apps ? 1 : afterOne.body.releases[0].downloads, 1);
	});

	it("keeps a version immutable", async () => {
		const again = await call(base, "/api/v1/apps/hello/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "hello", name: "Hello", version: "1.0.0" }) },
		});
		assert.equal(again.status, 409);
		assert.match(again.body.error, /already exists/);
	});

	it("rejects a traversal bundle and allows a corrected retry", async () => {
		const created = await call(base, "/api/v1/apps/retry/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "retry", name: "Retry", version: "0.1.0" }) },
		});
		assert.equal(created.status, 201);
		const evil = await tgz([
			{ name: "../evil", data: "x" },
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
		]);
		const denied = await call(base, created.body.upload.url, {
			method: "PUT",
			token,
			body: evil,
			headers: { "content-type": "application/gzip" },
		});
		assert.equal(denied.status, 422);
		assert.match(denied.body.error, /invalid bundle/);

		const good = await bundle();
		const retried = await call(base, created.body.upload.url, {
			method: "PUT",
			token,
			body: good,
			headers: { "content-type": "application/gzip" },
		});
		assert.equal(retried.status, 201, retried.text);
	});

	it("allows only one concurrent bundle upload per release", async () => {
		const created = await call(base, "/api/v1/apps/race/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "race", name: "Race", version: "1.0.0" }) },
		});
		assert.equal(created.status, 201);
		const one = await bundle({ files: { "index.html": "<h1>one</h1>" } });
		const two = await bundle({ files: { "index.html": "<h1>two</h1>" } });
		const [a, b] = await Promise.all([
			call(base, created.body.upload.url, { method: "PUT", token, body: one, headers: { "content-type": "application/gzip" } }),
			call(base, created.body.upload.url, { method: "PUT", token, body: two, headers: { "content-type": "application/gzip" } }),
		]);
		assert.deepEqual([a.status, b.status].sort(), [201, 409]);
		const detail = await call(base, "/api/v1/apps/race");
		const winner = detail.body.releases[0].bundleSha256;
		assert.ok(winner === sha256(one) || winner === sha256(two));
		const loser = winner === sha256(one) ? sha256(two) : sha256(one);
		assert.ok(!existsSync(join(dir, "blobs", `${loser}.tgz`)), "losing upload blob is removed");
	});
	it("hides yanked releases and blocks their download", async () => {
		const result = await publish("yanked", "0.1.0");
		assert.equal(result.uploaded.status, 201);
		const id = result.uploaded.body.release.id;
		assert.equal((await call(base, `/api/v1/releases/${id}/yank`, { method: "POST", token })).status, 200);
		const list = await call(base, "/api/v1/apps");
		assert.ok(!list.body.apps.some((app) => app.slug === "yanked"));
		assert.equal((await call(base, "/api/v1/apps/yanked")).status, 404);
		const dl = await call(base, "/api/v1/apps/yanked/releases/0.1.0/download");
		assert.equal(dl.status, 410);
	});

	it("stores an optional source archive", async () => {
		const result = await publish("withsource", "1.0.0");
		const source = Buffer.from("pretend this is a source tarball");
		const up = await call(base, `/api/v1/releases/${result.uploaded.body.release.id}/source`, {
			method: "PUT",
			token,
			body: source,
			headers: { "content-type": "application/gzip" },
		});
		assert.equal(up.status, 201);
		const dl = await fetch(`${base}/api/v1/apps/withsource/releases/1.0.0/source`);
		assert.equal(dl.status, 200);
		assert.deepEqual(Buffer.from(await dl.arrayBuffer()), source);
	});

	it("accepts reports and keeps them for the operator", async () => {
		const report = await call(base, "/api/v1/apps/hello/releases/1.0.0/report", {
			method: "POST",
			json: { reason: "The button does not do anything." },
		});
		assert.equal(report.status, 202);
		const denied = await call(base, "/api/v1/admin/reports");
		assert.equal(denied.status, 401);
		const reports = await call(base, "/api/v1/admin/reports", { headers: admin });
		assert.equal(reports.status, 200);
		assert.equal(reports.body.reports.length, 1);
		assert.equal(reports.body.reports[0].slug, "hello");
		assert.equal((await call(base, `/api/v1/admin/reports/${reports.body.reports[0].id}/resolve`, { method: "POST", headers: admin })).status, 200);
		assert.equal((await call(base, "/api/v1/admin/reports", { headers: admin })).body.reports.length, 0);
	});

	it("validates the manifest and the URL slug", async () => {
		const mismatch = await call(base, "/api/v1/apps/other/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "hello" }) },
		});
		assert.equal(mismatch.status, 422);
		const typo = await call(base, "/api/v1/apps/typo/releases", {
			method: "POST",
			token,
			json: { manifest: { ...manifest({ slug: "typo" }), egresss: [] } },
		});
		assert.equal(typo.status, 422);
		const badEgress = await call(base, "/api/v1/apps/badnet/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "badnet", egress: ["127.0.0.1"] }) },
		});
		assert.equal(badEgress.status, 422);
	});

	it("can require review before listing a release", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "cubby-api-review-"));
		const reviewed = createStore({ dataDir: dir2, adminToken: "review-secret", rateLimit: false, logging: false, requireReview: true });
		const address2 = await reviewed.listen(0, "127.0.0.1");
		const base2 = `http://127.0.0.1:${address2.port}`;
		try {
			const reg = await call(base2, "/api/v1/publishers", { method: "POST", json: { name: "reviewer", password: "correct horse battery" } });
			const tok = reg.body.token;
			const created = await call(base2, "/api/v1/apps/pending/releases", {
				method: "POST",
				token: tok,
				json: { manifest: manifest({ slug: "pending", name: "Pending", version: "1.0.0" }) },
			});
			const bytes = await bundle();
			const up = await call(base2, created.body.upload.url, { method: "PUT", token: tok, body: bytes, headers: { "content-type": "application/gzip" } });
			assert.equal(up.body.release.status, "pending");
			assert.equal((await call(base2, "/api/v1/apps")).body.total, 0);
			assert.equal((await call(base2, "/api/v1/apps/pending")).status, 404);
			const pending = await call(base2, "/api/v1/admin/pending", { headers: { "x-admin-token": "review-secret" } });
			assert.equal(pending.body.releases.length, 1);
			assert.equal((await call(base2, `/api/v1/admin/releases/${up.body.release.id}/approve`, { method: "POST", headers: { "x-admin-token": "review-secret" } })).status, 200);
			assert.equal((await call(base2, "/api/v1/apps/pending")).status, 200);
			assert.equal((await call(base2, "/api/v1/apps")).body.total, 1);
		} finally {
			await reviewed.close();
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
