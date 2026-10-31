import { fail, json } from "../lib/http.ts";
import { HOSTNAME, aliasCache } from "../lib/sites.ts";

/** PUT /__admin/alias?host=H&site=S serves site S under hostname H as well (same
 *  versions, same objects). DELETE /__admin/alias?host=H removes it. */
export async function alias(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!HOSTNAME.test(host) || host === env.ADMIN_HOST) return fail(400, "bad host");
	if (request.method === "DELETE") {
		await env.CODE.delete(`alias:${host}`);
		aliasCache.delete(host);
		return json({ host, alias: null });
	}
	const site = url.searchParams.get("site") ?? "";
	if (!HOSTNAME.test(site)) return fail(400, "bad site");
	if (site === host) return fail(400, "a hostname already serves the site with its own name");
	if ((await env.CODE.get(`site:${site}`)) === null) return fail(404, `no site ${site}`);
	// Don't silently hide a hostname that is itself a deployed site.
	if ((await env.CODE.get(`site:${host}`)) !== null) return fail(409, `${host} is a site of its own; it would be hidden`);
	await env.CODE.put(`alias:${host}`, site);
	aliasCache.delete(host);
	return json({ host, site });
}
