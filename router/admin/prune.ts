import { fail, json } from "../lib/http.ts";
import { listAll } from "../lib/util.ts";
import { metas } from "../serve/meta.ts";

/** Blobs no version uses may belong to a deploy in progress (uploaded, code not
 *  yet), or one that failed; they are deleted once they are this old. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;
/** Deploy history entries kept per site. */
const MAX_HISTORY = 100;

/** POST /__admin/prune?confirm=prune&keep=N[&orphanAge=S][&stagedAge=S] deletes
 *  stored versions except each site's current version, the N most recent versions
 *  in its deploy history (default 3), and versions staged for a deploy younger
 *  than stagedAge (default 3). Then it deletes the files no remaining version uses
 *  (blobs after an hour, or orphanAge seconds), history beyond the last 100 deploys
 *  per site, and index and staging records of things that are gone. Destructive and
 *  node-wide, so it needs confirm=prune; the numbers must be whole. */
export async function prune(env, url) {
	if (url.searchParams.get("confirm") !== "prune") {
		return fail(400, "prune deletes versions and history; add confirm=prune");
	}
	const keepParam = url.searchParams.get("keep");
	const orphanParam = url.searchParams.get("orphanAge");
	const stagedParam = url.searchParams.get("stagedAge");
	if (keepParam !== null && !/^\d+$/.test(keepParam)) return fail(400, "keep must be a whole number");
	if (orphanParam !== null && !/^\d+$/.test(orphanParam)) return fail(400, "orphanAge must be a whole number");
	if (stagedParam !== null && !/^\d+$/.test(stagedParam)) return fail(400, "stagedAge must be a whole number");
	const keep = Math.max(0, Math.min(100, Number(keepParam ?? 3)));
	const orphanAge = orphanParam !== null ? Number(orphanParam) * 1000 : ORPHAN_AGE_MS;
	const stagedAge = stagedParam !== null ? Number(stagedParam) * 1000 : ORPHAN_AGE_MS;
	const [siteKeys, deployKeys, codeKeys, stagedKeys, objKeys] = await Promise.all(
		["site:", "deploy:", "code:", "staged:", "obj:"].map((p) => listAll(env.CODE, p)),
	);
	const sites = new Set(siteKeys.map((k) => k.name.slice("site:".length)));
	const kept = new Set();
	for (const k of siteKeys) kept.add(await env.CODE.get(k.name));
	const history = new Map(); // site -> [{ at, key }]
	for (const k of deployKeys) {
		const rest = k.name.slice("deploy:".length);
		const site = rest.slice(0, rest.indexOf(":")); // site ids are hostnames: no ":"
		const list = history.get(site) ?? [];
		list.push({ at: rest.slice(site.length + 1), key: k.name });
		history.set(site, list);
	}
	let historyDeleted = 0;
	for (const list of history.values()) {
		list.sort((a, b) => b.at.localeCompare(a.at));
		const recent = [];
		for (const entry of list) {
			if (recent.length >= keep) break;
			const version = await env.CODE.get(entry.key);
			if (!recent.includes(version)) recent.push(version);
		}
		recent.forEach((v) => kept.add(v));
		for (const entry of list.slice(MAX_HISTORY)) {
			await env.CODE.delete(entry.key);
			historyDeleted++;
		}
	}
	// A version staged for a deploy that has not activated yet must survive the
	// prune, or the deploy fails at activation. A staging record without metadata
	// (written by a router before this existed) is treated as fresh once.
	const now = Date.now();
	for (const k of stagedKeys) {
		const version = k.name.slice(k.name.lastIndexOf(":") + 1);
		if (now - (k.metadata?.at ?? now) < stagedAge) kept.add(version);
	}
	const deleted = [];
	const remaining = new Set();
	const used = new Set(); // blob hashes of remaining versions
	const oldFormat = new Set(); // remaining versions whose files are asset: keys
	for (const k of codeKeys) {
		const version = k.name.slice("code:".length);
		if (kept.has(version)) {
			remaining.add(version);
			const code = await env.CODE.get(k.name, "json");
			if (code?.files) for (const [hash] of Object.values(code.files) as [string, any][]) used.add(hash);
			else oldFormat.add(version);
			continue;
		}
		await env.CODE.delete(k.name);
		metas.delete(version);
		deleted.push(version);
	}
	// Mark and sweep: blobs no remaining version uses (once old enough, see above).
	let blobsDeleted = 0;
	for (const b of await listAll(env.CODE, "blob:")) {
		if (used.has(b.name.slice("blob:".length)) || now - (b.metadata?.at ?? 0) < orphanAge) continue;
		await env.CODE.delete(b.name);
		blobsDeleted++;
	}
	// Old-format files, unless their version is still stored in that format. (A
	// version re-uploaded with the same content now uses blobs.) Nothing writes
	// asset: keys any more, so no deploy can be in progress for them.
	let oldFilesDeleted = 0;
	for (const a of await listAll(env.CODE, "asset:")) {
		if (oldFormat.has(a.name.slice("asset:".length, "asset:".length + 12))) continue;
		await env.CODE.delete(a.name);
		oldFilesDeleted++;
	}
	// Staging records of versions that no longer exist (version ids have no ":").
	for (const k of stagedKeys) if (!remaining.has(k.name.slice(k.name.lastIndexOf(":") + 1))) await env.CODE.delete(k.name);
	// Index entries of deleted sites.
	for (const k of objKeys) {
		const site = k.name.slice("obj:".length, k.name.indexOf("|"));
		if (!sites.has(site)) await env.CODE.delete(k.name);
	}
	return json({ keep, kept: [...kept].filter(Boolean), deleted, blobsDeleted, oldFilesDeleted, historyDeleted });
}
