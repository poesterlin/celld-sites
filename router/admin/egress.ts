import { egressCache, egressHosts } from "../egress/cache.ts";
import { internalHost } from "../egress/proxy.ts";
import { fail, json, jsonOrUndefined } from "../lib/http.ts";
import { HOSTNAME, siteFor, siteParam } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";

/** Abort every indexed object of `site`, so a changed egress allowlist reaches
 *  running facets immediately. Objects missing from the index (created before
 *  it existed) are not found; they are also the ones the dashboard reports as
 *  "not in the index". */
async function abortFacets(env, site) {
	const keys = await listAll(env.CODE, `obj:${site}|`);
	for (let i = 0; i < keys.length; i += 16) {
		await Promise.all(
			keys.slice(i, i + 16).map(async (k) => {
				const key = k.name.slice("obj:".length);
				const className = key.slice(site.length + 1, key.indexOf("|", site.length + 1));
				if (!className) return;
				try {
					await env.SITE_OBJECTS.getByName(key).rearm(className);
				} catch {}
			}),
		);
	}
}

/** GET /__admin/egress?host=H: the hosts H's site may fetch().
 *  PUT with a JSON array of hostnames replaces the list; DELETE clears it. */
export async function getEgress(env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!HOSTNAME.test(host)) return fail(400, "bad host");
	const site = await siteFor(env, host);
	return json({ host, site, allow: await egressHosts(env, site) });
}

const MAX_EGRESS_HOSTS = 20;
export async function putEgress(request, env, url) {
	// Allowed before the site exists: the store installer grants the declared
	// hosts first, so the deploy check runs with the permissions the app needs.
	const { host, site, refused } = await siteParam(env, url);
	if (refused) return refused;
	const list = await jsonOrUndefined(request);
	if (!Array.isArray(list)) return fail(400, "body must be a JSON array of hostnames");
	const allow = [];
	for (const raw of list) {
		if (typeof raw !== "string") return fail(400, "hostnames must be strings");
		const name = raw.trim().toLowerCase();
		if (!HOSTNAME.test(name)) return fail(400, `bad hostname: ${raw}`);
		const internal = internalHost(name, env.ADMIN_HOST);
		if (internal) return fail(400, `${name} ${internal} and cannot be allowlisted`);
		if (!allow.includes(name)) allow.push(name);
	}
	if (allow.length > MAX_EGRESS_HOSTS) return fail(400, `at most ${MAX_EGRESS_HOSTS} hostnames`);
	await env.CODE.put(`egress:${site}`, JSON.stringify(allow));
	egressCache.delete(site);
	// A running facet keeps the outbound network it was loaded with, including
	// pending timers, so it is aborted now rather than on its next call.
	await abortFacets(env, site);
	return json({ host, site, allow });
}

export async function deleteEgress(env, url) {
	const { host, site, refused } = await siteParam(env, url);
	if (refused) return refused;
	await env.CODE.delete(`egress:${site}`);
	egressCache.delete(site);
	await abortFacets(env, site);
	return json({ host, site, allow: [] });
}
