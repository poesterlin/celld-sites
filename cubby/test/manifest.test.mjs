import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManifestError, validateEgressHost, validateManifest, validatePublisherName, validateSlug, validateVersion } from "../lib/manifest.mjs";
import { manifest } from "./helpers.mjs";

describe("manifest validation", () => {
	it("accepts and normalizes a complete manifest", () => {
		const m = validateManifest({
			...manifest(),
			slug: "secret-santa",
			tags: ["Family", "fun"],
			egress: ["API.Example.COM", "api.example.com"],
			homepage: "https://example.com/app",
		});
		assert.equal(m.slug, "secret-santa");
		assert.deepEqual(m.tags, ["family", "fun"]);
		assert.deepEqual(m.egress, ["api.example.com"]);
		assert.equal(m.schema, 1);
	});
	it("accepts a sharing model of permissions and roles", () => {
		const m = validateManifest({
			...manifest(),
			permissions: [{ id: "edit", title: "Edit" }, { id: "comment" }],
			roles: [
				{ id: "editor", title: "Can edit", permissions: ["edit", "comment"], default: true },
				{ id: "viewer", title: "Can view", permissions: [] },
			],
		});
		assert.deepEqual(m.permissions.map((p) => p.id), ["edit", "comment"]);
		assert.equal(m.permissions[1].title, "comment");
		assert.deepEqual(m.roles[0], { id: "editor", title: "Can edit", permissions: ["edit", "comment"], default: true });
		assert.deepEqual(validateManifest(manifest()).roles, []);
	});
	it("rejects broken sharing models", () => {
		const bad = [
			{ roles: [{ id: "editor", permissions: ["edit"] }] }, // undeclared permission
			{ roles: [{ id: "owner", permissions: [] }] }, // reserved
			{ permissions: [{ id: "Edit" }] },
			{ permissions: [{ id: "edit" }, { id: "edit" }] },
			{ permissions: [{ id: "edit", sudo: true }] },
			{ roles: [{ id: "a", default: true }, { id: "b", default: true }] },
		];
		for (const over of bad) assert.throws(() => validateManifest({ ...manifest(), ...over }), ManifestError, JSON.stringify(over));
	});
	it("accepts single- or many-instance apps", () => {
		assert.equal(validateManifest({ ...manifest(), instances: "single" }).instances, "single");
		assert.equal(validateManifest({ ...manifest(), instances: "many" }).instances, undefined);
		assert.equal(validateManifest(manifest()).instances, undefined);
		for (const instances of ["one", 1, true, null]) assert.throws(() => validateManifest({ ...manifest(), instances }), ManifestError);
	});
	it("rejects unknown fields instead of silently dropping typos", () => {
		assert.throws(() => validateManifest({ ...manifest(), egresss: [] }), ManifestError);
	});
	it("requires a slug, name, summary, version and license", () => {
		for (const field of ["slug", "name", "summary", "version", "license"]) {
			const copy = manifest();
			delete copy[field];
			assert.throws(() => validateManifest(copy), ManifestError, field);
		}
	});
	it("enforces semver versions", () => {
		for (const good of ["1.0.0", "0.0.1", "2.3.4-beta.1", "10.20.30"]) validateVersion(good);
		for (const bad of ["1.0", "v1.0.0", "1.0.0.0", "01.0.0", "1.0.0-", "1.0.0\n"]) {
			assert.throws(() => validateVersion(bad), ManifestError, bad);
		}
	});
	it("enforces app ids and publisher names", () => {
		for (const good of ["ab", "secret-santa", "a1-b2"]) validateSlug(good);
		for (const bad of ["a", "-ab", "ab-", "Ab", "a_b", "a".repeat(41)]) assert.throws(() => validateSlug(bad), ManifestError, bad);
		for (const good of ["lab", "my-publisher"]) validatePublisherName(good);
		for (const bad of ["ab", "Lab", "-lab", "lab-", "lab_x"]) assert.throws(() => validatePublisherName(bad), ManifestError, bad);
	});
	it("allows public hostnames and rejects addresses and internal names", () => {
		for (const good of ["api.example.com", "xn--mnchen-3ya.de", "a-b.example.co.uk"]) assert.equal(validateEgressHost(good), good);
		for (const bad of [
			"127.0.0.1",
			"127.1",
			"0x7f.1",
			"1.2.3.4.5",
			"example.123",
			"localhost",
			"foo.local",
			"metadata.google.internal",
			"example.com:443",
			"user@example.com",
			"*.example.com",
			"exa mple.com",
			"example.test",
			"service.onion",
			"example.com.",
		]) {
			assert.throws(() => validateEgressHost(bad), ManifestError, bad);
		}
	});
	it("limits tags and egress lists", () => {
		assert.throws(() => validateManifest({ ...manifest(), tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }), /at most 8/);
		assert.throws(() => validateManifest({ ...manifest(), egress: Array.from({ length: 11 }, (_, i) => `h${i}.example.com`) }), /at most 10/);
		assert.throws(() => validateManifest({ ...manifest(), summary: "x".repeat(161) }), /longer than 160/);
	});
	it("accepts no egress as the safest default", () => {
		const m = manifest();
		delete m.egress;
		assert.deepEqual(validateManifest(m).egress, []);
	});
});
