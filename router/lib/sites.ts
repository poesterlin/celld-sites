import { fail } from "./http.ts";

export const VERSION = /^[a-f0-9]{12}$/;
export const SHA256 = /^[a-f0-9]{64}$/;

export const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** A site id is a hostname; the admin hostname is never a site. */
export const hostOk = (env, host) => HOSTNAME.test(host) && host !== env.ADMIN_HOST;
/** Deploy and write endpoints take a site id, not an alias: resolving an alias
 *  would let "deploy for vanity.test" silently change another site. */
export const aliasRefusal = async (env, host) => ((await env.CODE.get(`alias:${host}`)) !== null ? fail(409, `${host} is an alias; use its site id instead`) : null);

/** Hostname -> site id, cached briefly so routing costs no extra KV read per request. */
export const aliasCache = new Map();
export async function siteFor(env, host) {
	const hit = aliasCache.get(host);
	if (hit && hit.until > Date.now()) return hit.site;
	const site = (await env.CODE.get(`alias:${host}`)) ?? host;
	if (aliasCache.size > 1000) aliasCache.clear();
	aliasCache.set(host, { site, until: Date.now() + 5000 });
	return site;
}

/** The site a per-site admin call (?host=H) is about, or the answer refusing it. */
export async function siteParam(env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!hostOk(env, host)) return { refused: fail(400, "bad host") };
	const refusal = await aliasRefusal(env, host);
	if (refusal) return { refused: refusal };
	return { host, site: await siteFor(env, host) };
}

/** Deploy checks (POST /__admin/check) run a version with its Durable Objects under
 *  a scratch site id, so they start empty and never touch live data. Such ids can't
 *  collide with a real site: those are hostnames. */
export const scratchFor = (site, version) => `~check~${site}~${version}`;
export const isScratch = (site) => site.startsWith("~check~");

/** The real site behind a site id: a deploy check's scratch id belongs to the
 *  site it checks, and gets that site's allowlist. */
export const ownerOf = (site) => (isScratch(site) ? site.slice("~check~".length, site.lastIndexOf("~")) : site);
