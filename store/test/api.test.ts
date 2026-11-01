import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { publishRelease, rejectRelease, suspendPublisher, unsuspendPublisher, writeSetting } from "../releases.ts";
import { createStore } from "../server.ts";
import { bundle, call, codeRecord, manifest, sha256, tgz, type CallResult } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "store-api-test-"));
// STORE_TEST_DATABASE_URL runs the suite against a Postgres server (CI does);
// without it the store embeds Postgres in the data directory.
const databaseUrl = process.env.STORE_TEST_DATABASE_URL;
const store = createStore({ dataDir: dir, databaseUrl, rateLimit: false, logging: false, requireReview: false });
const address = await store.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${address.port}`;
let token;

after(async () => {
	await store.close();
	rmSync(dir, { recursive: true, force: true });
});

async function register(name: string): Promise<string> {
	const res = await call(base, "/api/v1/publishers", { method: "POST", json: { name, password: "correct horse battery", acceptPolicy: true } });
	assert.equal(res.status, 201, res.text);
	return res.body.token;
}

interface Published extends CallResult {
	uploaded?: CallResult;
	bytes?: Buffer;
}

async function publish(slug: string, version: string, over: Record<string, unknown> = {}, blob: Buffer | null = null): Promise<Published> {
	const created = await call(base, `/api/v1/apps/tester/${slug}/releases`, {
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
		const denied = await call(base, "/api/v1/apps/tester/nope/releases", { method: "POST", json: { manifest: manifest() } });
		assert.equal(denied.status, 401);
		const dup = await call(base, "/api/v1/publishers", { method: "POST", json: { name: "tester", password: "another password", acceptPolicy: true } });
		assert.equal(dup.status, 409);
		const noPolicy = await call(base, "/api/v1/publishers", { method: "POST", json: { name: "no-policy", password: "correct horse battery" } });
		assert.equal(noPolicy.status, 400);
		assert.match(noPolicy.body.error, /content policy/);
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

		const detail = await call(base, "/api/v1/apps/tester/hello");
		assert.equal(detail.status, 200);
		assert.equal(detail.body.releases.length, 1);
		assert.equal(detail.body.releases[0].manifest.egress.length, 0);

		const dl = await fetch(`${base}/api/v1/apps/tester/hello/releases/1.0.0/download`);
		assert.equal(dl.status, 200);
		const bytes = Buffer.from(await dl.arrayBuffer());
		assert.equal(dl.headers.get("x-bundle-sha256"), sha256(bytes));
		assert.deepEqual(bytes, result.bytes);
		const afterOne = await call(base, "/api/v1/apps/tester/hello");
		assert.equal(afterOne.body.apps ? 1 : afterOne.body.releases[0].downloads, 1);
	});

	it("keeps a version immutable", async () => {
		const again = await call(base, "/api/v1/apps/tester/hello/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "hello", name: "Hello", version: "1.0.0" }) },
		});
		assert.equal(again.status, 409);
		assert.match(again.body.error, /already exists/);
	});

	it("rejects a traversal bundle and allows a corrected retry", async () => {
		const created = await call(base, "/api/v1/apps/tester/retry/releases", {
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
		const created = await call(base, "/api/v1/apps/tester/race/releases", {
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
		const detail = await call(base, "/api/v1/apps/tester/race");
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
		assert.equal((await call(base, "/api/v1/apps/tester/keep")).status, 404);
		assert.equal((await call(base, "/api/v1/apps/tester/keep/releases/1.0.0/download")).status, 404);
		assert.ok(!existsSync(join(dir, "blobs", `${sha}.tgz`)), "the bundle file is deleted");
		const again = await publish("keep", "1.0.0", {}, await bundle({ files: { "index.html": "<h1>other</h1>" } }));
		assert.equal(again.status, 409);
		assert.match(again.body.error, /already exists/);
		// The owner still sees it, as removed, with the hash it had.
		const mine = await call(base, "/api/v1/apps/tester/keep", { token });
		assert.deepEqual(mine.body.releases.map((r) => [r.version, r.status, r.bundleSha256]), [["1.0.0", "removed", sha]]);
		// A removed release cannot get a new bundle either.
		const reupload = await call(base, `/api/v1/releases/${id}/bundle`, { method: "PUT", token, body: again.bytes ?? first.bytes, headers: { "content-type": "application/gzip" } });
		assert.equal(reupload.status, 410);

		// New versions are fine and bring the app back.
		assert.equal((await publish("keep", "1.0.1")).uploaded.status, 201);
		assert.equal((await call(base, "/api/v1/apps/tester/keep")).body.app.version, "1.0.1");
	});

	it("keeps a deleted app's name and versions reserved", async () => {
		assert.equal((await publish("gone", "2.0.0")).uploaded.status, 201);
		assert.equal((await call(base, "/api/v1/apps/tester/gone", { method: "DELETE", token })).status, 200);
		assert.equal((await call(base, "/api/v1/apps/tester/gone")).status, 404);
		assert.ok(!(await call(base, "/api/v1/apps")).body.apps.some((a) => a.slug === "gone"));

		const other = await register("someone-else");
		const taken = await call(base, "/api/v1/apps/tester/gone/releases", { method: "POST", token: other, json: { manifest: manifest({ slug: "gone", name: "Gone", version: "9.0.0" }) } });
		assert.equal(taken.status, 403, "another publisher cannot publish under tester/");
		const own = await call(base, "/api/v1/apps/someone-else/gone/releases", { method: "POST", token: other, json: { manifest: manifest({ slug: "gone", name: "Gone", version: "9.0.0" }) } });
		assert.equal(own.status, 201, "the same name in their own namespace is another app");
		assert.equal((await publish("gone", "2.0.0")).status, 409, "the old version stays taken");
		assert.equal((await publish("gone", "2.0.1")).uploaded.status, 201, "the owner can publish new versions");
	});

	it("names every app <publisher>/<app>", async () => {
		const list = await call(base, "/api/v1/apps?q=hello");
		assert.equal(list.body.apps[0].id, "tester/hello");
		assert.equal(list.body.apps[0].slug, "hello");
		// No bare names for new apps: nobody can claim "hello" for everyone.
		assert.equal((await call(base, "/api/v1/apps/hello")).status, 404);
		const old = await call(base, "/api/v1/apps/hello/releases", { method: "POST", token, json: { manifest: manifest({ slug: "hello", version: "9.9.9" }) } });
		assert.equal(old.status, 410, "an old CLI is told to update");
		assert.match(old.body.error, /update the hamstr CLI/);
	});

	it("keeps apps from before namespaces at their old address, by redirect", async () => {
		await store.db.run("UPDATE apps SET legacy = true WHERE ref = 'tester/hello'");
		try {
			const res = await fetch(`${base}/api/v1/apps/hello`, { redirect: "manual" });
			assert.equal(res.status, 308);
			assert.equal(res.headers.get("location"), "/api/v1/apps/tester/hello");
			const dl = await fetch(`${base}/api/v1/apps/hello/releases/1.0.0/download`, { redirect: "manual" });
			assert.equal(dl.headers.get("location"), "/api/v1/apps/tester/hello/releases/1.0.0/download");
			assert.equal((await call(base, "/api/v1/apps/hello")).body.app.id, "tester/hello", "clients follow it");
		} finally {
			await store.db.run("UPDATE apps SET legacy = false WHERE ref = 'tester/hello'");
		}
	});

	it("refuses publisher names that are reserved or read like another's", async () => {
		const cases: [string, RegExp][] = [
			["hamstr", /reserved/],
			["paypal-official", /reserved/],
			["store-app", /reserved/],
			["teste-r", /reads the same as the publisher "tester"/],
			["t3ster", /reads the same as the publisher "tester"/],
		];
		for (const [name, why] of cases) {
			const res = await call(base, "/api/v1/publishers", { method: "POST", json: { name, password: "correct horse battery", acceptPolicy: true } });
			assert.equal(res.status, 409, name);
			assert.match(res.body.error, why, name);
		}
	});

	it("has no admin endpoints: moderation is a separate site", async () => {
		assert.equal((await call(base, "/api/v1/admin/pending", { headers: { "x-admin-token": "anything" } })).status, 404);
	});

	it("keeps a version taken after a moderator rejects it, and tells the publisher why", async () => {
		const result = await publish("takedown", "1.0.0");
		const id = result.uploaded.body.release.id;
		assert.ok(await rejectRelease(store.db, id, { by: "mod", note: "Collects bank passwords." }));
		assert.equal((await call(base, "/api/v1/apps/tester/takedown/releases/1.0.0/download")).status, 404);
		assert.equal((await call(base, "/api/v1/apps/tester/takedown")).status, 404);
		assert.equal((await publish("takedown", "1.0.0")).status, 409);
		const me = await call(base, "/api/v1/me", { token });
		const release = me.body.apps.find((a) => a.slug === "takedown").releases[0];
		assert.equal(release.status, "rejected");
		assert.equal(release.reviewNote, "Collects bank passwords.");
		// The publisher cannot make the decision go away.
		assert.equal((await call(base, `/api/v1/releases/${id}`, { method: "DELETE", token })).status, 409);
		assert.equal((await call(base, `/api/v1/releases/${id}/yank`, { method: "POST", token })).status, 409);
	});

	it("hides yanked releases and blocks their download", async () => {
		const result = await publish("yanked", "0.1.0");
		assert.equal(result.uploaded.status, 201);
		const id = result.uploaded.body.release.id;
		assert.equal((await call(base, `/api/v1/releases/${id}/yank`, { method: "POST", token })).status, 200);
		const list = await call(base, "/api/v1/apps");
		assert.ok(!list.body.apps.some((app) => app.slug === "yanked"));
		assert.equal((await call(base, "/api/v1/apps/tester/yanked")).status, 404);
		const dl = await call(base, "/api/v1/apps/tester/yanked/releases/0.1.0/download");
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
		const dl = await fetch(`${base}/api/v1/apps/tester/withsource/releases/1.0.0/source`);
		assert.equal(dl.status, 200);
		assert.deepEqual(Buffer.from(await dl.arrayBuffer()), source);
	});

	it("accepts reports and keeps them for the moderators", async () => {
		const report = await call(base, "/api/v1/apps/tester/hello/releases/1.0.0/report", {
			method: "POST",
			json: { reason: "The button does not do anything." },
		});
		assert.equal(report.status, 202);
		const rows = await store.db.query("SELECT rep.reason, a.slug FROM reports rep JOIN releases r ON r.id = rep.release_id JOIN apps a ON a.id = r.app_id WHERE NOT rep.resolved");
		assert.deepEqual(rows, [{ reason: "The button does not do anything.", slug: "hello" }]);
	});

	it("validates the manifest and the URL slug", async () => {
		const mismatch = await call(base, "/api/v1/apps/tester/other/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "hello" }) },
		});
		assert.equal(mismatch.status, 422);
		const typo = await call(base, "/api/v1/apps/tester/typo/releases", {
			method: "POST",
			token,
			json: { manifest: { ...manifest({ slug: "typo" }), egresss: [] } },
		});
		assert.equal(typo.status, 422);
		const badEgress = await call(base, "/api/v1/apps/tester/badnet/releases", {
			method: "POST",
			token,
			json: { manifest: manifest({ slug: "badnet", egress: ["127.0.0.1"] }) },
		});
		assert.equal(badEgress.status, 422);
	});

	it("filters by category and exact tag, and keeps both current on update", async () => {
		assert.equal((await publish("board", "1.0.0", { category: "family", tags: ["family", "fun"] })).uploaded.status, 201);
		assert.equal((await publish("chess", "1.0.0", { category: "games", tags: ["fun", "family-game"] })).uploaded.status, 201);
		const slugs = async (query) => (await call(base, `/api/v1/apps?${query}`)).body.apps.map((a) => a.slug).sort();

		assert.deepEqual(await slugs("tag=family"), ["board"]);
		assert.deepEqual(await slugs("tag=fun"), ["board", "chess"]);
		assert.deepEqual(await slugs("category=games"), ["chess"]);
		assert.deepEqual(await slugs("category=games&tag=family"), []);
		assert.deepEqual(await slugs("q=family-game"), ["chess"]);
		assert.equal((await call(base, "/api/v1/apps/tester/board")).body.app.category, "family");

		const counts = async () => Object.fromEntries((await call(base, "/api/v1/categories")).body.categories.map((c) => [c.id, c.count]));
		const before = await counts();
		assert.equal(before.family, 1);
		assert.equal(before.games, 1);
		assert.equal(before.money, 0);

		assert.equal((await publish("board", "1.1.0", { category: "productivity", tags: ["notes"] })).uploaded.status, 201);
		assert.deepEqual(await slugs("tag=family"), []);
		assert.deepEqual(await slugs("tag=notes"), ["board"]);
		const after = await counts();
		assert.equal(after.family, 0);
		assert.equal(after.productivity, 1);

		const bad = await call(base, "/api/v1/apps/tester/board/releases", { method: "POST", token, json: { manifest: manifest({ slug: "board", version: "1.2.0", category: "misc" }) } });
		assert.equal(bad.status, 422);
	});

	it("searches by word, prefix, typo and accent, best match first", async () => {
		const published = async (slug: string, name: string, summary: string, description = "") => {
			assert.equal((await publish(slug, "1.0.0", { name, summary, description })).uploaded.status, 201);
		};
		await published("tuner", "Guitar Tuner", "Tune your guitar by ear", "A chromatic tuner with a metronome.");
		await published("pins", "Pinboard", "A board for notes", "Stick notes on a shared board.");
		await published("cafe", "Café Ledger", "Track café spendings", "What you spend on coffee.");
		await published("sketch", "Excalidraw", "A whiteboard", "Sketch diagrams together.");

		const names = async (q: string) => (await call(base, `/api/v1/apps?q=${encodeURIComponent(q)}`)).body.apps.map((a) => a.name);
		const total = async (q: string) => (await call(base, `/api/v1/apps?q=${encodeURIComponent(q)}`)).body.total;

		// Case never matters.
		assert.deepEqual(await names("TUNER"), ["Guitar Tuner"]);
		// Half-typed words and typos still find the app.
		assert.deepEqual(await names("pinb"), ["Pinboard"]);
		assert.deepEqual(await names("pinbord"), ["Pinboard"]);
		// Accents are folded in both directions.
		assert.deepEqual(await names("cafe"), ["Café Ledger"]);
		assert.deepEqual(await names("CAFÉ"), ["Café Ledger"]);
		// Words in the description count too.
		assert.deepEqual(await names("metronome"), ["Guitar Tuner"]);
		// Every word has to match; stop words are ignored.
		assert.deepEqual(await names("the guitar tuner"), ["Guitar Tuner"]);
		// Exact names beat apps that merely mention the word.
		assert.equal((await names("board"))[0], "board");
		assert.ok((await names("board")).includes("Pinboard"));
		// LIKE wildcards in the query are text, not patterns.
		assert.equal(await total("%"), 0);
		assert.equal(await total("_"), 0);
		// The count matches the rows for a query that fits on one page.
		const result = await call(base, "/api/v1/apps?q=pinbord");
		assert.equal(result.body.total, result.body.apps.length);
	});

	it("can require review before listing a release", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "store-api-review-"));
		const reviewed = createStore({ dataDir: dir2, rateLimit: false, logging: false, requireReview: true });
		const address2 = await reviewed.listen(0, "127.0.0.1");
		const base2 = `http://127.0.0.1:${address2.port}`;
		try {
			const reg = await call(base2, "/api/v1/publishers", { method: "POST", json: { name: "reviewer", password: "correct horse battery", acceptPolicy: true } });
			const tok = reg.body.token;
			const created = await call(base2, "/api/v1/apps/reviewer/pending/releases", {
				method: "POST",
				token: tok,
				json: { manifest: manifest({ slug: "pending", name: "Pending", version: "1.0.0" }) },
			});
			const bytes = await bundle();
			const up = await call(base2, created.body.upload.url, { method: "PUT", token: tok, body: bytes, headers: { "content-type": "application/gzip" } });
			assert.equal(up.body.release.status, "pending");
			assert.equal((await call(base2, "/api/v1/apps")).body.total, 0);
			assert.equal((await call(base2, "/api/v1/apps/reviewer/pending")).status, 404);
			// The owner sees it waiting.
			assert.equal((await call(base2, "/api/v1/me", { token: tok })).body.apps[0].releases[0].status, "pending");
			assert.equal((await call(base2, "/api/v1/apps/reviewer/pending/releases/1.0.0/download")).status, 404);
			assert.ok(await publishRelease(reviewed.db, up.body.release.id, { by: "mod" }));
			assert.equal((await call(base2, "/api/v1/apps/reviewer/pending")).status, 200);
			assert.equal((await call(base2, "/api/v1/apps")).body.total, 1);

			// A release waiting for review never changes the live listing: a
			// harmless 1.0.0 cannot be renamed by an unreviewed 1.1.0.
			const created2 = await call(base2, "/api/v1/apps/reviewer/pending/releases", {
				method: "POST",
				token: tok,
				json: { manifest: manifest({ slug: "pending", name: "Your Bank Login", summary: "Sign in to your bank.", version: "1.1.0", tags: ["bank"] }) },
			});
			const up2 = await call(base2, created2.body.upload.url, { method: "PUT", token: tok, body: await bundle({ version: "bbbbbbbbbbbb" }), headers: { "content-type": "application/gzip" } });
			assert.equal(up2.body.release.status, "pending");
			const listed = (await call(base2, "/api/v1/apps")).body.apps[0];
			assert.equal(listed.name, "Pending");
			assert.equal(listed.version, "1.0.0");
			assert.deepEqual((await call(base2, "/api/v1/apps?tag=bank")).body.apps, []);
			assert.equal((await call(base2, "/api/v1/apps/reviewer/pending")).body.app.name, "Pending");
			// Approval brings the new listing.
			assert.ok(await publishRelease(reviewed.db, up2.body.release.id, { by: "mod" }));
			assert.equal((await call(base2, "/api/v1/apps/reviewer/pending")).body.app.name, "Your Bank Login");
		} finally {
			await reviewed.close();
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("refuses files past the publisher's limits and keeps no temp file", async () => {
		const dir3 = mkdtempSync(join(tmpdir(), "store-api-quota-"));
		const small = createStore({ dataDir: dir3, rateLimit: false, logging: false, limits: { publisherBytes: 1, source: 512 * 1024 } });
		const address3 = await small.listen(0, "127.0.0.1");
		const base3 = `http://127.0.0.1:${address3.port}`;
		const tmp3 = join(dir3, "tmp");
		try {
			const reg = await call(base3, "/api/v1/publishers", { method: "POST", json: { name: "quota", password: "correct horse battery", acceptPolicy: true } });
			const tok = reg.body.token;
			const created = await call(base3, `/api/v1/apps/quota/big/releases`, {
				method: "POST",
				token: tok,
				json: { manifest: manifest({ slug: "big", name: "Big", version: "1.0.0" }) },
			});
			// A bundle the node accepts, refused only by the storage quota.
			const bytes = await bundle();
			const over = await call(base3, created.body.upload.url, { method: "PUT", token: tok, body: bytes, headers: { "content-type": "application/gzip" } });
			assert.equal(over.status, 413, over.text);
			assert.match(over.body.error, /storage limit/);
			assert.deepEqual(readdirSync(tmp3), [], "the refused bundle left a temp file");
			assert.equal((await call(base3, "/api/v1/apps/quota/big/releases/1.0.0/download")).status, 404);

			// A source archive larger than the limit never reaches the quota check.
			const big = Buffer.alloc(1024 * 1024, 1);
			const tooBig = await call(base3, `/api/v1/releases/${created.body.release.id}/source`, {
				method: "PUT",
				token: tok,
				body: big,
				headers: { "content-type": "application/gzip" },
			});
			assert.equal(tooBig.status, 413, tooBig.text);
			assert.match(tooBig.body.error, /larger than/);
			assert.deepEqual(readdirSync(tmp3), [], "the refused source left a temp file");
		} finally {
			await small.close();
			rmSync(dir3, { recursive: true, force: true });
		}
	});
});

describe("publisher accounts", () => {
	const origin = () => base;
	const cookieFrom = (res: Response) => /store_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
	const web = (path: string, init: RequestInit & { cookie?: string; json?: unknown } = {}) =>
		fetch(base + path, {
			method: init.method ?? "GET",
			headers: {
				...(init.json !== undefined && { "content-type": "application/json" }),
				...(init.cookie && { cookie: `store_session=${init.cookie}` }),
				...((init.headers as Record<string, string>) ?? {}),
			},
			body: init.json === undefined ? undefined : JSON.stringify(init.json),
		});

	it("signs up and in on the web with an HttpOnly, SameSite=Strict session", async () => {
		const signup = await web("/api/v1/publishers", { method: "POST", json: { name: "webby", password: "correct horse battery", acceptPolicy: true, session: true }, headers: { origin: origin() } });
		assert.equal(signup.status, 201);
		const header = signup.headers.get("set-cookie");
		assert.match(header, /HttpOnly/);
		assert.match(header, /SameSite=Strict/);
		assert.match(header, /Path=\/api/);
		const body: any = await signup.json();
		assert.equal(body.token, undefined, "the web never sees a token");
		const cookie = cookieFrom(signup);
		const me: any = await (await web("/api/v1/me", { cookie })).json();
		assert.equal(me.publisher.name, "webby");
		assert.ok(me.publisher.policyAcceptedAt);

		const login = await web("/api/v1/session", { method: "POST", json: { name: "webby", password: "correct horse battery" } });
		assert.equal(login.status, 201);
		assert.equal((await web("/api/v1/session", { method: "POST", json: { name: "webby", password: "wrong password!" } })).status, 401);
	});

	it("refuses cookie-signed changes from other origins, and session cookies as CLI tokens", async () => {
		const login = await web("/api/v1/session", { method: "POST", json: { name: "webby", password: "correct horse battery" } });
		const cookie = cookieFrom(login);
		const forged = await web("/api/v1/tokens", { method: "POST", cookie, headers: { origin: "https://evil.example" } });
		assert.equal(forged.status, 403);
		assert.equal((await web("/api/v1/tokens", { method: "POST", cookie })).status, 403, "no Origin header");
		// From the store's own pages, a session mints a CLI token without the password.
		const minted = await web("/api/v1/tokens", { method: "POST", cookie, headers: { origin: origin() } });
		assert.equal(minted.status, 201);
		const cli = ((await minted.json()) as any).token;
		assert.equal((await call(base, "/api/v1/me", { token: cli })).status, 200);
		// The session value is not accepted as a Bearer token, nor the token as a cookie.
		assert.equal((await call(base, "/api/v1/me", { token: decodeURIComponent(cookie) })).status, 401);
		assert.equal((await web("/api/v1/me", { cookie: cli })).status, 401);
		// Signing out ends the session.
		assert.equal((await web("/api/v1/session", { method: "DELETE", cookie, headers: { origin: origin() } })).status, 200);
		assert.equal((await web("/api/v1/me", { cookie })).status, 401);
	});

	it("changes the password and ends the other sign-ins", async () => {
		const other = (await call(base, "/api/v1/tokens", { method: "POST", json: { name: "webby", password: "correct horse battery" } })).body.token;
		const cookie = cookieFrom(await web("/api/v1/session", { method: "POST", json: { name: "webby", password: "correct horse battery" } }));
		const wrong = await web("/api/v1/me/password", { method: "POST", cookie, headers: { origin: origin() }, json: { current: "nope nope nope", next: "a new long password" } });
		assert.equal(wrong.status, 401);
		const changed = await web("/api/v1/me/password", { method: "POST", cookie, headers: { origin: origin() }, json: { current: "correct horse battery", next: "a new long password" } });
		assert.equal(changed.status, 200);
		assert.equal((await web("/api/v1/me", { cookie })).status, 200, "this session stays");
		assert.equal((await call(base, "/api/v1/me", { token: other })).status, 401, "the CLI token ended");
		assert.equal((await call(base, "/api/v1/tokens", { method: "POST", json: { name: "webby", password: "a new long password" } })).status, 201);
	});

	it("suspends a publisher: no sign-in, no publishing, apps hidden until lifted", async () => {
		const tok = await register("shady");
		const created = await call(base, "/api/v1/apps/shady/shady-app/releases", { method: "POST", token: tok, json: { manifest: manifest({ slug: "shady-app", name: "Shady", version: "1.0.0" }) } });
		const bytes = await bundle({ version: "cccccccccccc", files: { "index.html": "<h1>shady</h1>" } });
		assert.equal((await call(base, created.body.upload.url, { method: "PUT", token: tok, body: bytes, headers: { "content-type": "application/gzip" } })).status, 201);
		assert.equal((await call(base, "/api/v1/apps/shady/shady-app")).status, 200);

		const { id } = await store.db.one("SELECT id FROM publishers WHERE name = 'shady'");
		assert.ok(await suspendPublisher(store.db, id, { by: "mod", reason: "phishing" }));
		assert.equal((await call(base, "/api/v1/me", { token: tok })).status, 401, "tokens are gone");
		const login = await call(base, "/api/v1/tokens", { method: "POST", json: { name: "shady", password: "correct horse battery" } });
		assert.equal(login.status, 403);
		assert.match(login.body.error, /suspended: phishing/);
		assert.equal((await call(base, "/api/v1/apps/shady/shady-app")).status, 404);
		assert.equal((await call(base, "/api/v1/apps/shady/shady-app/releases/1.0.0/download")).status, 404);
		assert.ok(!(await call(base, "/api/v1/apps?limit=100")).body.apps.some((a) => a.slug === "shady-app"));

		assert.ok(await unsuspendPublisher(store.db, id, { by: "mod" }));
		assert.equal((await call(base, "/api/v1/apps/shady/shady-app")).status, 200);
	});

	it("follows the registration and publishing switches", async () => {
		await writeSetting(store.db, "registration", false, "mod");
		await writeSetting(store.db, "publishing", false, "mod");
		// The store caches the switches for a few seconds.
		await new Promise((r) => setTimeout(r, 5100));
		try {
			const reg = await call(base, "/api/v1/publishers", { method: "POST", json: { name: "latecomer", password: "correct horse battery", acceptPolicy: true } });
			assert.equal(reg.status, 503);
			assert.equal((await publish("paused", "1.0.0")).status, 503);
			const health = (await call(base, "/api/health")).body;
			assert.equal(health.registration, false);
			assert.equal(health.publishing, false);
		} finally {
			await writeSetting(store.db, "registration", true, "mod");
			await writeSetting(store.db, "publishing", true, "mod");
		}
	});
});

describe("rate limits behind proxies", () => {
	it("counts visitors by the header the proxy sets, not by the last proxy hop", async () => {
		const dir3 = mkdtempSync(join(tmpdir(), "store-api-ip-"));
		const limited = createStore({ dataDir: dir3, logging: false, clientIpHeader: "X-Real-Ip" });
		const base3 = `http://127.0.0.1:${(await limited.listen(0, "127.0.0.1")).port}`;
		try {
			// Through Traefik twice, the last X-Forwarded-For hop is Traefik for everyone.
			const from = (ip: string) => ({ "x-forwarded-for": `${ip}, 172.18.0.50`, "x-real-ip": ip });
			const register = (name: string, ip: string) =>
				call(base3, "/api/v1/publishers", { method: "POST", headers: from(ip), json: { name, password: "correct horse battery", acceptPolicy: true } });
			for (let i = 0; i < 5; i++) assert.equal((await register(`visitor-a${i}`, "203.0.113.7")).status, 201);
			assert.equal((await register("visitor-a5", "203.0.113.7")).status, 429, "one visitor is limited");
			assert.equal((await register("visitor-b0", "203.0.113.8")).status, 201, "another visitor is not");
		} finally {
			await limited.close();
			rmSync(dir3, { recursive: true, force: true });
		}
	});
});

describe("legal pages", () => {
	it("serves the operator's Impressum and Datenschutz from STORE_LEGAL_DIR and links them", async () => {
		const legal = mkdtempSync(join(tmpdir(), "store-legal-"));
		writeFileSync(join(legal, "impressum.html"), "<h1>Impressum</h1>");
		const s = createStore({ dataDir: mkdtempSync(join(tmpdir(), "store-legal-data-")), legalDir: legal, logging: false, rateLimit: false });
		const b = `http://127.0.0.1:${(await s.listen(0, "127.0.0.1")).port}`;
		try {
			const page = await fetch(`${b}/impressum`);
			assert.equal(page.status, 200);
			assert.equal(await page.text(), "<h1>Impressum</h1>");
			assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
			assert.deepEqual((await call(b, "/api/health")).body.legal, { imprint: "/impressum", privacy: null }, "only pages that exist are linked");
		} finally {
			await s.close();
			rmSync(legal, { recursive: true, force: true });
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
		const base = `http://127.0.0.1:${(web2.server.address() as AddressInfo).port}`;
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
				const text = await new Promise<string>((ok, fail) =>
					httpRequest({ host: "127.0.0.1", port: (web2.server.address() as AddressInfo).port, path }, (res) => {
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
