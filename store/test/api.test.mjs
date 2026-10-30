import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createStore } from "../server.mjs";
import { bundle, call, codeRecord, manifest, sha256, tgz } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "store-api-test-"));
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
		assert.equal(await rawStatus("/api/health", { Host: "store.localhost:abc" }), 200);
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
		assert.equal(dl.headers.get("x-bundle-sha256"), sha256(bytes));
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
	it("never lets a deleted version come back with other content", async () => {
		const first = await publish("keep", "1.0.0", {}, await bundle({ files: { "index.html": "<h1>keep one</h1>" } }));
		assert.equal(first.uploaded.status, 201);
		const sha = sha256(first.bytes);
		const id = first.uploaded.body.release.id;
		assert.equal((await call(base, `/api/v1/releases/${id}`, { method: "DELETE", token })).status, 200);

		// Gone from the catalog and from disk, but the version stays taken.
		assert.equal((await call(base, "/api/v1/apps/keep")).status, 404);
		assert.equal((await call(base, "/api/v1/apps/keep/releases/1.0.0/download")).status, 404);
		assert.ok(!existsSync(join(dir, "blobs", `${sha}.tgz`)), "the bundle file is deleted");
		const again = await publish("keep", "1.0.0", {}, await bundle({ files: { "index.html": "<h1>other</h1>" } }));
		assert.equal(again.status, 409);
		assert.match(again.body.error, /already exists/);
		// The owner still sees it, as removed, with the hash it had.
		const mine = await call(base, "/api/v1/apps/keep", { token });
		assert.deepEqual(mine.body.releases.map((r) => [r.version, r.status, r.bundleSha256]), [["1.0.0", "removed", sha]]);
		// A removed release cannot get a new bundle either.
		const reupload = await call(base, `/api/v1/releases/${id}/bundle`, { method: "PUT", token, body: again.bytes ?? first.bytes, headers: { "content-type": "application/gzip" } });
		assert.equal(reupload.status, 410);

		// New versions are fine and bring the app back.
		assert.equal((await publish("keep", "1.0.1")).uploaded.status, 201);
		assert.equal((await call(base, "/api/v1/apps/keep")).body.app.version, "1.0.1");
	});

	it("keeps a deleted app's name and versions reserved", async () => {
		assert.equal((await publish("gone", "2.0.0")).uploaded.status, 201);
		assert.equal((await call(base, "/api/v1/apps/gone", { method: "DELETE", token })).status, 200);
		assert.equal((await call(base, "/api/v1/apps/gone")).status, 404);
		assert.ok(!(await call(base, "/api/v1/apps")).body.apps.some((a) => a.slug === "gone"));

		const other = await register("someone-else");
		const taken = await call(base, "/api/v1/apps/gone/releases", { method: "POST", token: other, json: { manifest: manifest({ slug: "gone", name: "Gone", version: "9.0.0" }) } });
		assert.equal(taken.status, 403, "another publisher cannot take the name");
		assert.equal((await publish("gone", "2.0.0")).status, 409, "the old version stays taken");
		assert.equal((await publish("gone", "2.0.1")).uploaded.status, 201, "the owner can publish new versions");
	});

	it("keeps a version taken after an operator takedown", async () => {
		const result = await publish("takedown", "1.0.0");
		const id = result.uploaded.body.release.id;
		assert.equal((await call(base, `/api/v1/admin/releases/${id}`, { method: "DELETE", headers: admin })).status, 200);
		assert.equal((await call(base, "/api/v1/apps/takedown/releases/1.0.0/download")).status, 404);
		assert.equal((await publish("takedown", "1.0.0")).status, 409);
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
		const dir2 = mkdtempSync(join(tmpdir(), "store-api-review-"));
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

describe("web UI", () => {
	it("serves the app shell for pages, with its bootstrap script allowed by hash", async () => {
		const web = mkdtempSync(join(tmpdir(), "store-web-test-"));
		mkdirSync(join(web, "_app", "immutable"), { recursive: true });
		const script = `\n__sveltekit_x = { base: "" };\n`;
		writeFileSync(join(web, "index.html"), `<!doctype html><html><head></head><body><script>${script}</script></body></html>`);
		writeFileSync(join(web, "ui.css"), "body{}");
		writeFileSync(join(web, "_app", "immutable", "start.abc.js"), "export {}");
		const web2 = createStore({ dataDir: mkdtempSync(join(tmpdir(), "store-web-data-")), webDir: web, logging: false, rateLimit: false });
		await web2.listen(0, "127.0.0.1");
		const base = `http://127.0.0.1:${web2.server.address().port}`;
		try {
			for (const path of ["/", "/apps/secret-santa", "/demo/abcdef123456", "/about"]) {
				const res = await fetch(base + path);
				assert.equal(res.status, 200, path);
				assert.match(res.headers.get("content-type"), /text\/html/);
				assert.equal(res.headers.get("cache-control"), "no-cache");
				const hash = createHash("sha256").update(script).digest("base64");
				assert.match(res.headers.get("content-security-policy"), new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, "\\$&")}'`));
			}
			const css = await fetch(`${base}/ui.css`);
			assert.equal(css.status, 200);
			assert.match(css.headers.get("content-type"), /text\/css/);
			assert.doesNotMatch(css.headers.get("content-security-policy"), /sha256-/);
			const asset = await fetch(`${base}/_app/immutable/start.abc.js`);
			assert.match(asset.headers.get("cache-control"), /immutable/);
			// Missing files with an extension are 404s, not the app shell; nothing escapes the build.
			assert.equal((await fetch(`${base}/missing.js`)).status, 404);
			// Encoded dot segments are resolved by the URL parser, so this lands on a page path.
			for (const path of ["/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd", "/_app/../../../etc/hostname"]) {
				const text = await new Promise((ok, fail) =>
					httpRequest({ host: "127.0.0.1", port: web2.server.address().port, path }, (res) => {
						let body = "";
						res.on("data", (d) => (body += d));
						res.on("end", () => ok(`${res.statusCode} ${body}`));
					}).on("error", fail).end(),
				);
				assert.match(text, /^(200 <!doctype html>|404 )/, path);
				assert.doesNotMatch(text, /root:/, path);
			}
			assert.equal((await fetch(`${base}/index.html`)).status, 404);
		} finally {
			await web2.close();
		}
	});
});
