import { versionForSite } from "./deploy.ts";
import { fail, json } from "../lib/http.ts";
import { VERSION, aliasRefusal, hostOk, scratchFor, siteFor } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";
import { serveWithLimit } from "../serve/limit.ts";
import { assetFor, siteMeta } from "../serve/meta.ts";

/** POST /__admin/check?host=H&version=V  runs an uploaded version the way it would
 *  serve H, without activating it, and requests its check path (celld.json "check",
 *  default "/"; false skips the check). Its Durable Objects live in a scratch
 *  namespace: they start empty, so the version's migrations run on fresh databases,
 *  and are deleted afterwards. Answers { ok, status, ms, path[, error] }; ok means a
 *  response started within the time limit with a status below 500. Problems that
 *  only appear with real data are for the deploy to catch after activation. */
export async function check(env, ctx, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!hostOk(env, host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const refusal = await aliasRefusal(env, host);
	if (refusal) return refusal;
	const code = await env.CODE.get(`code:${version}`, "json");
	if (!code) return fail(404, `version ${version} is not uploaded`);
	const site = await siteFor(env, host);
	if (!(await versionForSite(env, site, version))) {
		return fail(409, `version ${version} was not uploaded for ${site} (use PUT /code?host=${site} or POST /stage)`);
	}
	const path = code.check === false ? null : (code.check ?? "/");
	if (path === null) return json({ ok: true, skipped: true });
	const scratch = scratchFor(site, version);
	// A path that exists as a static file never reaches the worker, so a broken
	// worker would pass. Probe an unknown path too when the site has one; a 404 is
	// fine (it still ran the handler), a 5xx is not.
	const paths = [path];
	const meta = await siteMeta(env, version);
	let staticCheck = false;
	try {
		staticCheck = Boolean(assetFor(meta, new URL(`https://${host}${path}`).pathname));
	} catch {}
	if (path === "/" && meta.worker && staticCheck) paths.push(`/~check-${version}`);
	const started = Date.now();
	let status = 0;
	let error;
	let failed = null;
	for (const p of paths) {
		const request = new Request(`https://${host}${p}`, { headers: { accept: "text/html", "user-agent": "celld-sites deploy check" } });
		try {
			const res = await serveWithLimit(request, env, ctx, scratch, version);
			status = res.status;
			if (status >= 500) {
				failed = { path: p, status, error: (await res.text()).slice(0, 500) };
				break;
			}
			await res.body?.cancel();
		} catch (e) {
			failed = { path: p, status: 500, error: String(e?.message ?? e).slice(0, 500) };
			break;
		}
	}
	const ms = Date.now() - started;
	const cleanup = [];
	for (const k of await listAll(env.CODE, `obj:${scratch}|`)) {
		const key = k.name.slice("obj:".length);
		try {
			await env.SITE_OBJECTS.getByName(key).destroy(key.split("|")[1]);
			await env.CODE.delete(k.name);
		} catch (e) {
			const message = `${key}: ${String(e?.message ?? e).slice(0, 200)}`;
			console.warn(`deploy check cleanup failed: ${message}`);
			cleanup.push(message);
		}
	}
	return json({
		ok: failed === null,
		status: failed?.status ?? status,
		ms,
		path: failed?.path ?? path,
		...(failed?.error !== undefined && { error: failed.error }),
		...(cleanup.length && { cleanup }),
	});
}
