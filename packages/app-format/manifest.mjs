// Manifest rules shared by the publisher CLI and the store API.
//
// A manifest describes the applet a publisher is shipping. It is deliberately
// small and strict: the store only needs enough to list, search and display the
// app, and the installer needs the one permission that matters (egress). The
// platform-specific build config stays in the app's celld.json.

export class ManifestError extends Error {}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const PUBLISHER = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const TAG = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z][a-z0-9-]*|xn--[a-z0-9-]+)$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const INTERNAL = [".internal", ".local", ".localhost", ".home.arpa", ".test", ".invalid", ".example", ".onion"];
const FIELDS = new Set(["schema", "slug", "name", "summary", "description", "version", "license", "homepage", "source", "icon", "tags", "egress", "permissions", "roles", "instances", "export"]);
const PERMISSION_ID = /^[a-z][a-z0-9-]{0,30}$/;

const fail = (msg) => {
	throw new ManifestError(msg);
};
const str = (v, field, min, max) => {
	if (typeof v !== "string") fail(`${field} must be a string`);
	const s = v.trim();
	if (s.length < min) fail(`${field} is required`);
	if (s.length > max) fail(`${field} is longer than ${max} characters`);
	return s;
};
const optionalUrl = (v, field) => {
	if (v === undefined) return undefined;
	const s = str(v, field, 1, 300);
	let u;
	try {
		u = new URL(s);
	} catch {
		fail(`${field} must be an absolute http(s) URL`);
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") fail(`${field} must be an http(s) URL`);
	if (u.username || u.password) fail(`${field} must not contain credentials`);
	return s;
};

/** Validate a publisher name (part of `hamstr register`). */
export function validatePublisherName(value) {
	if (typeof value !== "string" || !PUBLISHER.test(value)) {
		throw new ManifestError("publisher name must be 3-30 characters: lowercase letters, digits and dashes");
	}
	return value;
}

export function validateSlug(value) {
	if (typeof value !== "string" || !SLUG.test(value)) {
		throw new ManifestError("app id must be 2-40 characters: lowercase letters, digits and dashes, not starting or ending with a dash");
	}
	return value;
}

export function validateVersion(value) {
	if (typeof value !== "string" || value.length > 40 || !VERSION.test(value)) {
		throw new ManifestError("version must be semver, e.g. 1.0.0 or 0.2.1-beta.1");
	}
	return value;
}

/** A hostname an app may fetch. The store rejects names a public app must never
 *  need (IP literals, single labels, internal suffixes, numeric TLDs); the
 *  installer shows the list and refuses to grant it without consent. */
export function validateEgressHost(value) {
	const host = String(value ?? "").trim().toLowerCase();
	if (!host || host.length > 253) throw new ManifestError("egress hostnames must be 1-253 characters");
	if (/[\s/\\@:*"'<>]/.test(host)) throw new ManifestError(`bad egress hostname: ${value}`);
	const labels = host.split(".");
	if (labels.length < 2) throw new ManifestError(`egress hostname ${host} must be a fully qualified name, not a single label`);
	if (!labels.every((l) => LABEL.test(l))) throw new ManifestError(`bad egress hostname: ${value}`);
	if (IPV4.test(host) || host.includes(":")) throw new ManifestError(`egress hostname ${host} is an IP address`);
	const suffix = INTERNAL.find((s) => host.endsWith(s));
	if (suffix) throw new ManifestError(`egress hostname ${host} ends in ${suffix} and cannot be requested`);
	if (!TLD.test(labels[labels.length - 1])) throw new ManifestError(`egress hostname ${host} has a numeric or invalid top-level domain`);
	return host;
}

/**
 * Validate and normalize a `hamstr.json` manifest.
 * Throws ManifestError with a human message; returns the trimmed manifest.
 */
export function validateManifest(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) fail("manifest must be a JSON object");
	for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail(`unknown manifest field: ${key}`);
	const schema = input.schema ?? 1;
	if (schema !== 1) fail("manifest schema must be 1");

	const slug = validateSlug(input.slug);
	const name = str(input.name, "name", 1, 60);
	const summary = str(input.summary, "summary", 1, 160);
	const description = input.description === undefined ? "" : str(input.description, "description", 0, 8000);
	const version = validateVersion(input.version);
	const license = str(input.license, "license", 1, 40); // SPDX id or "Proprietary"; not enforced
	const homepage = optionalUrl(input.homepage, "homepage");
	const source = optionalUrl(input.source, "source");
	const icon = input.icon === undefined ? "" : str(input.icon, "icon", 0, 16);
	if (/[\u0000-\u001f\u007f]/.test(icon)) fail("icon must not contain control characters");

	let tags = [];
	if (input.tags !== undefined) {
		if (!Array.isArray(input.tags) || input.tags.length > 8) fail("tags must be an array of at most 8 strings");
		tags = [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()))];
		for (const tag of tags) if (!TAG.test(tag)) fail(`bad tag: ${tag} (1-20 chars: a-z, 0-9, dashes)`);
	}

	let egress = [];
	if (input.egress !== undefined) {
		if (!Array.isArray(input.egress) || input.egress.length > 10) fail("egress must be an array of at most 10 hostnames");
		egress = [...new Set(input.egress.map(validateEgressHost))];
	}

	// `roles` is still accepted so manifests written for the old sharing model
	// publish; it is ignored and left out of the result (remove it from FIELDS in
	// the next release).
	const permissions = validatePermissions(input.permissions);

	// Hamstr: "single" apps give each person one instance that opens directly
	// (a family board); "many" (the default) lets people make as many as they like.
	if (input.instances !== undefined && input.instances !== "single" && input.instances !== "many") fail('instances must be "single" or "many"');
	const instances = input.instances === "single" ? { instances: "single" } : {};

	// Hamstr: a GET path in the app that answers with one grain's data as a file
	// (JSON, CSV, a zip, ...). Hamstr calls it as the owner for "Download data".
	if (input.export !== undefined) {
		const path = input.export;
		if (typeof path !== "string" || !/^\/(?![/\\])[\x21-\x7e]{0,199}$/.test(path) || /[\\#]/.test(path) || path.startsWith("/.hamstr/")) {
			fail('export must be a path in the app, such as "/export"');
		}
	}
	const exportPath = input.export === undefined ? {} : { export: input.export };

	return { schema: 1, slug, name, summary, description, version, license, homepage, source, icon, tags, egress, permissions, ...instances, ...exportPath };
}

/** Optional permissions, read by Hamstr: what the app checks (sent in
 *  X-Hamstr-Permissions). The grain's owner holds every one. */
function validatePermissions(permInput) {
	const textOf = (v, field, max) => (v === undefined ? undefined : str(v, field, 1, max));
	let permissions = [];
	if (permInput !== undefined) {
		if (!Array.isArray(permInput) || permInput.length > 16) fail("permissions must be an array of at most 16 entries");
		permissions = permInput.map((p, i) => {
			if (!p || typeof p !== "object" || Array.isArray(p)) fail(`permissions[${i}] must be an object`);
			for (const key of Object.keys(p)) if (!["id", "title", "description"].includes(key)) fail(`unknown field permissions[${i}].${key}`);
			if (typeof p.id !== "string" || !PERMISSION_ID.test(p.id)) fail(`permissions[${i}].id must be 1-31 characters: a-z, 0-9, dashes, starting with a letter`);
			const description = textOf(p.description, `permissions[${i}].description`, 200);
			return { id: p.id, title: str(p.title ?? p.id, `permissions[${i}].title`, 1, 60), ...(description && { description }) };
		});
		const ids = permissions.map((p) => p.id);
		if (new Set(ids).size !== ids.length) fail("permission ids must be unique");
	}
	return permissions;
}

/** Parse and validate manifest text (used by the CLI). */
export function parseManifest(json) {
	let value;
	try {
		value = JSON.parse(json);
	} catch {
		fail("hamstr.json is not valid JSON");
	}
	return validateManifest(value);
}
