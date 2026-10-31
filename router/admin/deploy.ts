import { setDeclaredAuth, validAuth } from "../auth/policy.ts";
import { codes } from "../isolate/code.ts";
import { fail, json, tooLarge } from "../lib/http.ts";
import { SHA256, VERSION, aliasRefusal, hostOk, siteFor } from "../lib/sites.ts";
import { hex, listAll } from "../lib/util.ts";
import { DEFAULT_IMMUTABLE, badAssetPath, metas } from "../serve/meta.ts";

/** Largest single static file (KV allows 25 MiB per value). */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
/** Largest code upload (bundled server code plus the file list). */
const MAX_CODE_BYTES = 16 * 1024 * 1024;

/** Most files in one version. */
const MAX_FILES = 20_000;

/** PUT /__admin/blob?hash=H  body: the file bytes; H must be their SHA-256. */
export async function putBlob(request, env, url) {
	const hash = url.searchParams.get("hash") ?? "";
	if (!SHA256.test(hash)) return fail(400, "bad hash");
	const big = tooLarge(request, MAX_ASSET_BYTES);
	if (big) return big;
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_ASSET_BYTES) return fail(413, "file too large");
	if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== hash) return fail(400, "body does not match hash");
	await env.CODE.put(`blob:${hash}`, bytes, { metadata: { at: Date.now() } });
	return json({ hash, bytes: bytes.byteLength });
}

/** Which of `hashes` are stored. A deploy asks about its own files (usually tens
 *  to hundreds), so each is looked up by key prefix, 16 at a time; only for very
 *  large file sets is one listing of every stored blob cheaper. */
async function storedBlobs(env, hashes) {
	const unique = [...new Set(hashes)];
	if (unique.length > 2000) {
		const all = new Set((await listAll(env.CODE, "blob:")).map((k) => k.name.slice("blob:".length)));
		return new Set(unique.filter((h) => all.has(h)));
	}
	const stored = new Set();
	for (let i = 0; i < unique.length; i += 16) {
		await Promise.all(
			unique.slice(i, i + 16).map(async (h) => {
				const page = await env.CODE.list({ prefix: `blob:${h}`, limit: 1 });
				if (page.keys.some((k) => k.name === `blob:${h}`)) stored.add(h);
			}),
		);
	}
	return stored;
}

/** POST /__admin/blobs/missing  body: JSON array of SHA-256 hashes. Answers { missing }:
 *  the ones a deploy has to upload. */
export async function missingBlobs(request, env) {
	const big = tooLarge(request, MAX_CODE_BYTES);
	if (big) return big;
	let hashes;
	try {
		hashes = await request.json();
	} catch {
		return fail(400, "body is not JSON");
	}
	if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && SHA256.test(h))) {
		return fail(400, "body must be a JSON array of SHA-256 hashes");
	}
	const stored = await storedBlobs(env, hashes);
	return json({ missing: [...new Set(hashes)].filter((h) => !stored.has(h)) });
}

/** Two code records are the same version only if every field matches. Used to
 *  make `code:<version>` write-once while still accepting the re-upload of an
 *  unchanged build (push.sh does that on every deploy). */
const canonicalFiles = (files) =>
	JSON.stringify(
		Object.keys(files)
			.sort()
			.map((p) => [p, files[p]]),
	);
const sameCode = (a, b) =>
	a.compatibilityDate === b.compatibilityDate &&
	a.source === b.source &&
	canonicalFiles(a.files) === canonicalFiles(b.files) &&
	(a.immutable ?? DEFAULT_IMMUTABLE).join("\0") === b.immutable.join("\0") &&
	(a.mutable ?? []).join("\0") === b.mutable.join("\0") &&
	(a.notFound ?? "none") === b.notFound;

/** PUT /__admin/code?version=V[&host=H]
 *  body: { compatibilityDate, source, files: { path: [sha256, type] }, immutable, mutable, notFound }.
 *  Refused unless every file's blob was uploaded first. `host` records the version
 *  as staged for H's site, so activation and admin object calls may target it.
 *  A version id is immutable: the same record may be uploaded again (an unchanged
 *  build), a different one is refused, so "version V is live" cannot be changed
 *  after activation without a new id. */
export async function putCode(request, env, url) {
	const version = url.searchParams.get("version") ?? "";
	const host = url.searchParams.get("host");
	if (!VERSION.test(version)) return fail(400, "bad version");
	if (host !== null && !hostOk(env, host)) return fail(400, "bad host");
	if (host !== null) {
		const refusal = await aliasRefusal(env, host);
		if (refusal) return refusal;
	}
	const big = tooLarge(request, MAX_CODE_BYTES);
	if (big) return big;
	let body;
	try {
		body = await request.json();
	} catch {
		return fail(400, "body is not JSON");
	}
	const { compatibilityDate, source = "", files, immutable = DEFAULT_IMMUTABLE, mutable = [], notFound = "none", check = "/", auth } = body;
	const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
	const entries = files && typeof files === "object" && !Array.isArray(files) ? Object.entries(files) : null;
	const valid =
		typeof compatibilityDate === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) &&
		typeof source === "string" &&
		entries !== null &&
		entries.length <= MAX_FILES &&
		entries.every(
			([path, f]) =>
				path &&
				!path.startsWith("/") &&
				!path.includes("\0") &&
				!badAssetPath(path) &&
				new TextEncoder().encode(path).length <= 400 &&
				Array.isArray(f) &&
				f.length === 2 &&
				SHA256.test(f[0]) &&
				typeof f[1] === "string" &&
				f[1].length <= 200 &&
				!/[\r\n]/.test(f[1]),
		) &&
		strings(immutable) &&
		strings(mutable) &&
		(notFound === "none" || notFound === "spa") &&
		(check === false || (typeof check === "string" && check.startsWith("/") && check.length <= 400)) &&
		(auth === undefined || validAuth(auth));
	if (!valid) return fail(400, "bad code record");
	const stored = await storedBlobs(env, entries.map(([, f]) => f[0]));
	const missing = entries.filter(([, f]) => !stored.has(f[0])).map(([path]) => path);
	if (missing.length) return fail(409, `missing ${missing.length} files, e.g. ${missing.slice(0, 3).join(", ")}`);
	// `auth` (celld.json) is not part of the code record: identical builds share one
	// record across sites, and a policy must only ever change its own site. It
	// travels with the staging record and is applied on activation.
	const record = { compatibilityDate, source, files, immutable, mutable, notFound, check };
	const existing = await env.CODE.get(`code:${version}`, "json");
	// A version stored before content-addressed files has no file list; replacing
	// that record with the blob format is the documented upgrade path. A legacy
	// version that is live is not rewritten in place (that would swap the code of
	// an approved version); it needs a new version id.
	const upgrade = existing !== null && existing.files === undefined;
	if (upgrade) {
		for (const k of await listAll(env.CODE, "site:")) {
			if ((await env.CODE.get(k.name)) === version) return fail(409, `version ${version} is live; deploy it in the blob format as a new version instead`);
		}
	}
	if (existing !== null && !upgrade && !sameCode(existing, record)) {
		return fail(409, `version ${version} already exists with different content; build again for a new id`);
	}
	const site = host === null ? null : await siteFor(env, host);
	if (site !== null && !(await canStage(env, site, version))) return fail(429, `at most ${MAX_STAGED} staged versions per site; activate or delete one first`);
	if (existing === null || upgrade) {
		await env.CODE.put(`code:${version}`, JSON.stringify(record), { metadata: { files: entries.length } });
		metas.delete(version);
		codes.delete(version);
	} else if ((existing.check ?? "/") !== check) {
		// `check` is deploy metadata, not part of the version id: editing only it in
		// celld.json must not force a new build. The code fields stay immutable.
		await env.CODE.put(`code:${version}`, JSON.stringify(record), { metadata: { files: entries.length } });
		codes.delete(version);
	}
	if (site !== null) await env.CODE.put(`staged:${site}:${version}`, "", { metadata: { at: Date.now(), auth: auth ?? null } });
	return json({ version, files: entries.length, sourceBytes: source.length, ...(site !== null && { site }), ...(existing !== null && !upgrade && { unchanged: true }) });
}

/** Staged versions kept per site: enough for a deploy in flight and a manual
 *  binding, without letting a control plane fill the bucket with staging records. */
const MAX_STAGED = 20;

/** Whether another staged version may be added (idempotent for one already staged). */
async function canStage(env, site, version) {
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return true;
	const page = await env.CODE.list({ prefix: `staged:${site}:`, limit: MAX_STAGED });
	return page.keys.length < MAX_STAGED;
}

/** POST /__admin/stage?host=H&version=V  records an already-uploaded version as
 *  built for H's site, so it may be activated for it. PUT /code?host= also stages;
 *  this is for a control plane that uploads first and binds the site later. */
export async function stageVersion(env, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	if ((await env.CODE.get(`code:${version}`)) === null) return fail(404, `version ${version} is not uploaded`);
	const site = await siteFor(env, host);
	if (!(await canStage(env, site, version))) return fail(429, `at most ${MAX_STAGED} staged versions per site; activate or delete one first`);
	await env.CODE.put(`staged:${site}:${version}`, "", { metadata: { at: Date.now() } });
	return json({ host, site, version });
}

/** Whether `version` may run as `site`: it was staged for it (PUT /code?host= or
 *  POST /stage), it is in its deploy history (rollback), or it is active now. */
export async function versionForSite(env, site, version) {
	if ((await env.CODE.get(`site:${site}`)) === version) return true;
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return true;
	for (const k of await listAll(env.CODE, `deploy:${site}:`)) if ((await env.CODE.get(k.name)) === version) return true;
	return false;
}

/** POST /__admin/activate?host=H&version=V[&ifNew=1]  points H's site at a version
 *  uploaded for it (a new deploy, or a rollback to an older one). With ifNew, a
 *  site that already has an active version is left alone (bundled sites on node
 *  start). A version built for another site is refused: running it here would run
 *  that site's code against this site's Durable Objects. */
export async function activate(env, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	const code = await env.CODE.get(`code:${version}`, "json");
	if (!code) return fail(404, `version ${version} is not uploaded (or was pruned)`);
	const site = await siteFor(env, host);
	if (url.searchParams.get("ifNew") === "1") {
		const current = await env.CODE.get(`site:${site}`);
		if (current !== null) return json({ host, site, version: current, skipped: true });
	}
	if (!(await versionForSite(env, site, version))) {
		return fail(409, `version ${version} was not uploaded for ${site} (use PUT /code?host=${site} or POST /stage)`);
	}
	const previous = await env.CODE.get(`site:${site}`);
	const auth = await authForSwitch(env, site, version);
	const summary = { assets: code.files ? Object.keys(code.files).length : (code.assets?.length ?? 0), sourceBytes: code.source?.length ?? 0, auth: auth.mode };
	// History first, then the switch: KV has no transactions, and a crash between the
	// two then leaves a history entry for a version that never went live (harmless:
	// prune keeps one version more) rather than a live version prune can't see in
	// the history. The suffix keeps two activations in the same millisecond apart.
	await auth.before();
	await env.CODE.put(`deploy:${site}:${new Date().toISOString()}~${crypto.randomUUID().slice(0, 8)}`, version, { metadata: summary });
	await env.CODE.put(`site:${site}`, version); // the switch
	await auth.after();
	// The deploy is done: the staging hint has served its purpose (the version is
	// now in the history, which is what rollback and seeding check).
	await env.CODE.delete(`staged:${site}:${version}`);
	return json({ host, site, version, previous, ...summary });
}

/** The celld.json sign-in mode (null: none) that activating `version` gives the
 *  site: from the staging record for a new deploy, from the history for a
 *  rollback, so rolling back restores that version's protection too. A version
 *  staged by POST /stage, or deployed before sign-in existed, keeps the site's
 *  current mode. A stricter mode is applied before the switch (`before`), a
 *  looser one after it (`after`), so the site is never briefly less protected
 *  than either version. `mode` is what the deploy history records. */
async function authForSwitch(env, site, version) {
	const declared = await declaredAuthFor(env, site, version);
	const apply = (when) => async () => {
		if (declared !== undefined && (declared === "required") === (when === "before")) await setDeclaredAuth(env, site, declared);
	};
	const mode = declared !== undefined ? declared : ((await env.CODE.get(`auth:${site}`, "json"))?.declared ?? null);
	return { mode, before: apply("before"), after: apply("after") };
}

/** The sign-in mode `version` was deployed to `site` with: "required", "optional",
 *  null (none), or undefined when nothing says (keep the current one). */
async function declaredAuthFor(env, site, version) {
	const staged = await env.CODE.getWithMetadata(`staged:${site}:${version}`);
	if (staged?.metadata && "auth" in staged.metadata) return validAuth(staged.metadata.auth) ? staged.metadata.auth : null;
	let latest;
	for (const k of await listAll(env.CODE, `deploy:${site}:`)) {
		if (k.metadata && "auth" in k.metadata && (!latest || k.name > latest.name) && (await env.CODE.get(k.name)) === version) latest = k;
	}
	return latest ? (validAuth(latest.metadata.auth) ? latest.metadata.auth : null) : undefined;
}
