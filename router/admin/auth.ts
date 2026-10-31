import { updateAuth, validAuth } from "../auth/policy.ts";
import { fail, json, jsonOrUndefined } from "../lib/http.ts";
import { HOSTNAME, siteFor, siteParam } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";

/** GET /__admin/auth[?host=H]: the sign-in policy of H's site (declared, operator
 *  override, effective mode), or of every site. */
export async function getAuth(env, url) {
	const one = async (site) => {
		if (!(await env.CODE.get(`site:${site}`))) return null;
		const record = (await env.CODE.get(`auth:${site}`, "json")) ?? {};
		const declared = validAuth(record.declared) ? record.declared : null;
		const override = validAuth(record.override) ? record.override : null;
		return { site, mode: override ?? declared, declared, override };
	};
	const host = url.searchParams.get("host");
	if (host !== null) {
		if (!HOSTNAME.test(host)) return fail(400, "bad host");
		const found = await one(await siteFor(env, host));
		return found ? json({ host, ...found }) : fail(404, "no such site");
	}
	const ids = (await listAll(env.CODE, "site:")).map((k) => k.name.slice(5));
	return json({ sites: (await Promise.all(ids.map(one))).filter(Boolean) });
}

/** PUT /__admin/auth?host=H  body {"mode":"required"|"optional"}: override the policy. */
export async function putAuth(request, env, url) {
	const { host, site, refused } = await siteParam(env, url);
	if (refused) return refused;
	const body = await jsonOrUndefined(request);
	if (!validAuth(body?.mode)) return fail(400, 'body must be {"mode": "required" | "optional"}');
	if ((await env.CODE.get(`site:${site}`)) === null) return fail(404, "no such site");
	await updateAuth(env, site, { override: body.mode });
	return json({ host, site, mode: body.mode });
}

export async function deleteAuth(env, url) {
	const { host, site, refused } = await siteParam(env, url);
	if (refused) return refused;
	await updateAuth(env, site, { override: null });
	return json({ host, site });
}
