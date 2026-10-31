import { ownerOf } from "../lib/sites.ts";

/** celld.json `auth`: "required" (sign in to enter) or "optional" (everyone may
 *  enter; signed-in people are recognised). Who may enter is the sign-in service's. */
export const validAuth = (a) => a === "required" || a === "optional";

/** The effective policy of a site: { mode, declared, override } or null (no sign-in). */
const AUTH_TTL_MS = 30_000;
/** auth:<site> -> { declared, override }: the mode from the active deploy's
 *  celld.json, and the sign-in service's override, which wins. Per site, never per
 *  version, and cached for AUTH_TTL_MS so every router isolate converges. */
export const authCache = new Map(); // site -> { policy, until }
export async function authPolicy(env, site) {
	const owner = ownerOf(site);
	const hit = authCache.get(owner);
	if (hit && hit.until > Date.now()) return hit.policy;
	const record = (await env.CODE.get(`auth:${owner}`, "json")) ?? {};
	const declared = validAuth(record.declared) ? record.declared : null;
	const override = validAuth(record.override) ? record.override : null;
	const mode = override ?? declared;
	const policy = mode ? { mode, declared, override } : null;
	if (authCache.size > 1000) authCache.clear();
	authCache.set(owner, { policy, until: Date.now() + AUTH_TTL_MS });
	return policy;
}

/** Change one half of auth:<site>, dropping the key when both are empty. */
export async function updateAuth(env, site, patch) {
	const record = { ...((await env.CODE.get(`auth:${site}`, "json")) ?? {}), ...patch };
	if (!record.declared && !record.override) await env.CODE.delete(`auth:${site}`);
	else await env.CODE.put(`auth:${site}`, JSON.stringify({ declared: record.declared ?? null, override: record.override ?? null }));
	authCache.delete(site);
}
export const setDeclaredAuth = (env, site, mode) => updateAuth(env, site, { declared: mode });
