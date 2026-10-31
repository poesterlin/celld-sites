import { ownerOf } from "../lib/sites.ts";
import { hex } from "../lib/util.ts";

/** Allowlists are read on every site request (to pick the isolate), so they are
 *  cached for a minute per router isolate; PUT/DELETE /egress clear the entry here,
 *  other router isolates pick a change up within that minute. */
const EGRESS_TTL_MS = 60_000;
export const egressCache = new Map(); // site -> { allow, tag, until }
export async function egressFor(env, site) {
	const owner = ownerOf(site);
	const hit = egressCache.get(owner);
	if (hit && hit.until > Date.now()) return hit;
	const stored = await env.CODE.get(`egress:${owner}`, "json");
	const allow = Array.isArray(stored) ? stored : [];
	// The list is part of the loader key, so a changed list gets a new isolate with
	// the new proxy instead of waiting for the old one to be evicted.
	const tag = allow.length ? `~e${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(allow.join(",")))).slice(0, 32)}` : "";
	const entry = { allow, tag, until: Date.now() + EGRESS_TTL_MS };
	if (egressCache.size > 1000) egressCache.clear();
	egressCache.set(owner, entry);
	return entry;
}
export const egressHosts = async (env, site) => (await egressFor(env, site)).allow;
