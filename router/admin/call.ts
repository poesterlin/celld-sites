import { egressFor } from "../egress/cache.ts";
import { fail, json, tooLarge } from "../lib/http.ts";
import { Timeout, objectTimeoutMs, withTimeout } from "../lib/limits.ts";
import { VERSION, hostOk, siteFor } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";
import { RESERVED_METHOD } from "../objects/names.ts";
import { claimObject, indexObject } from "../objects/registry.ts";

/** Largest argument payload for an admin object call. */
const MAX_CALL_BYTES = 8 * 1024 * 1024;

/** Why an admin call may not run `version` on the site's objects, or null if it may.
 *  Only the active version touches live data: any other version's code (and its
 *  constructor migrations) would run against the data the live version is using, and
 *  swap the class under it. A site that is not live yet may be seeded with a
 *  version staged for it (PUT /code?host=), or one from its history. */
async function callRefusal(env, site, version) {
	const active = await env.CODE.get(`site:${site}`);
	if (active === version) return null;
	if (active !== null) {
		return `${site} is live with version ${active}; seeding another version would run its code on live data (activate it first)`;
	}
	if ((await env.CODE.get(`staged:${site}:${version}`)) !== null) return null;
	for (const k of await listAll(env.CODE, `deploy:${site}:`)) if ((await env.CODE.get(k.name)) === version) return null;
	return `version ${version} was not uploaded for ${site}`;
}

/** POST /__admin/call?host=H&class=C&name=N&method=M[&version=V]  body: JSON array of args.
 *  Runs a method on one of H's site's Durable Objects and returns { result }. This is
 *  how data is seeded or exported: site code has no secrets, so it cannot guard such
 *  routes itself. `version` seeds a site that is not live yet with a version staged
 *  for it (see callRefusal). */
export async function adminCall(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	const className = url.searchParams.get("class") ?? "";
	const name = url.searchParams.get("name") ?? "";
	const method = url.searchParams.get("method") ?? "";
	const ident = /^[A-Za-z_$][\w$]*$/;
	if (!hostOk(env, host) || !ident.test(className) || !ident.test(method) || !name || name.length > 200) {
		return fail(400, "need host, class, name and method");
	}
	if (RESERVED_METHOD.test(method)) return fail(400, `${method} is reserved; use /__admin/dump and /__admin/restore`);
	const big = tooLarge(request, MAX_CALL_BYTES);
	if (big) return big;
	let args;
	try {
		const text = await request.text();
		args = text.trim() ? JSON.parse(text) : [];
	} catch {
		return fail(400, "body must be a JSON array of arguments");
	}
	if (!Array.isArray(args)) return fail(400, "body must be a JSON array of arguments");
	const site = await siteFor(env, host);
	const version = url.searchParams.get("version") ?? (await env.CODE.get(`site:${site}`));
	if (!version || !VERSION.test(version)) return fail(404, `no site for ${host}`);
	if ((await env.CODE.get(`code:${version}`)) === null) return fail(404, `version ${version} is not uploaded`);
	const refusal = await callRefusal(env, site, version);
	if (refusal) return fail(409, refusal);
	const key = `${site}|${className}|${name}`;
	if (new TextEncoder().encode(key).length > 500) return fail(400, "bad object reference");
	try {
		await claimObject(env, site, key);
	} catch (e) {
		if (/object quota/.test(String(e?.message ?? e))) return fail(429, e.message);
		throw e;
	}
	await indexObject(env, key);
	try {
		const { allow, tag } = await egressFor(env, site);
		const call = env.SITE_OBJECTS.getByName(key).handle(site, version, tag, allow, className, method, args);
		const result = await withTimeout(call, objectTimeoutMs(env), `${className}.${method}`);
		return json({ site, className, name, method, result: result ?? null });
	} catch (e) {
		if (e instanceof Timeout) return fail(504, e.message);
		if (/object quota/.test(String(e?.message ?? e))) return fail(429, e.message);
		return fail(500, `${className}.${method}: ${String(e?.message ?? e).slice(0, 500)}`);
	}
}
