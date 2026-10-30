import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BundleError, readBundle } from "../../packages/app-format/bundle.ts";
import { bundle, codeRecord, sha256, tgz } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "store-bundle-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const file = async (bytes) => {
	const path = join(dir, `b${counter++}.tgz`);
	writeFileSync(path, bytes);
	return path;
};

describe("bundle validation", () => {
	it("reads a valid bundle and extracts only its files", async () => {
		const path = await file(await bundle({ files: { "index.html": "<h1>hi</h1>", "app.js": "console.log(1)" } }));
		const tree = join(dir, "tree-ok");
		const meta = await readBundle(path, { extractTo: tree });
		assert.equal(meta.version, "aaaaaaaaaaaa");
		assert.equal(meta.files, 2);
		assert.equal(readFileSync(join(tree, "blobs", sha256("<h1>hi</h1>")), "utf8"), "<h1>hi</h1>");
		assert.equal(readFileSync(join(tree, "blobs", sha256("console.log(1)")), "utf8"), "console.log(1)");
		assert.equal(readFileSync(join(tree, "version"), "utf8").trim(), "aaaaaaaaaaaa");
	});
	it("rejects path traversal before extracting", async () => {
		const bytes = await tgz([
			{ name: "../evil", data: "x" },
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
		]);
		const tree = join(dir, "tree-traversal");
		await assert.rejects(readBundle(await file(bytes), { extractTo: tree }), /unsafe archive path/);
	});
	it("rejects symlinks and other non-regular entries", async () => {
		const bytes = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
			{ name: "blobs/link", type: "symlink", linkname: "/etc/passwd" },
		]);
		await assert.rejects(readBundle(await file(bytes)), /symlink|regular files/);
	});
	it("rejects a blob whose content does not match its name", async () => {
		const name = `blobs/${sha256("expected")}`;
		const bytes = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord({ files: { "x.txt": "expected" } })) },
			{ name, data: "actual" },
		]);
		await assert.rejects(readBundle(await file(bytes)), /does not match its content hash/);
	});
	it("rejects unreferenced and missing blobs", async () => {
		const extra = sha256("extra");
		const unreferenced = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
			{ name: `blobs/${extra}`, data: "extra" },
		]);
		await assert.rejects(readBundle(await file(unreferenced)), /unreferenced blob/);

		const missing = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord({ files: { "x.txt": "x" } })) },
		]);
		await assert.rejects(readBundle(await file(missing)), /missing blob/);
	});
	it("rejects duplicate entries, bad versions and missing code", async () => {
		const version = "aaaaaaaaaaaa\n";
		const duplicate = await tgz([
			{ name: "version", data: version },
			{ name: "version", data: version },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
		]);
		await assert.rejects(readBundle(await file(duplicate)), /duplicate archive entry/);

		const badVersion = await tgz([
			{ name: "version", data: "NOT-A-VERSION\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
		]);
		await assert.rejects(readBundle(await file(badVersion)), /12 lowercase hex/);

		const noCode = await tgz([{ name: "version", data: version }]);
		await assert.rejects(readBundle(await file(noCode)), /no code.json/);
	});
	it("refuses paths in the code record that could escape", async () => {
		const record = codeRecord({ files: { "../x.txt": "x" } });
		const bytes = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(record) },
			{ name: `blobs/${sha256("x")}`, data: "x" },
		]);
		await assert.rejects(readBundle(await file(bytes)), /unsafe file path/);
	});
	it("enforces per-file, total and compressed limits", async () => {
		const big = "x".repeat(64);
		const payload = await bundle({ files: { "big.txt": big } });
		await assert.rejects(readBundle(await file(payload), { limits: { file: 16 } }), /larger than/);
		await assert.rejects(readBundle(await file(payload), { limits: { uncompressed: 32 } }), /larger than/);
		await assert.rejects(readBundle(await file(payload), { limits: { compressed: 32 } }), /bundle is larger/);
	});
	it("counts and caps PAX metadata", async () => {
		const bytes = await tgz([
			{ name: "version", data: "aaaaaaaaaaaa\n" },
			{ name: "code.json", data: JSON.stringify(codeRecord()) },
			{ name: "x", data: "x", pax: { comment: "x".repeat(70 * 1024) } },
		]);
		await assert.rejects(readBundle(await file(bytes), { limits: { raw: 1024 } }), /unpacked tar stream is larger/);
	});
	it("rejects a truncated gzip file", async () => {
		const good = await bundle();
		await assert.rejects(readBundle(await file(good.subarray(0, good.length - 10))), BundleError);
	});
});
