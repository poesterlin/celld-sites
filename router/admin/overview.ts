import { fail, json } from "../lib/http.ts";
import { listAll } from "../lib/util.ts";

/** GET /__admin/overview: sites (with aliases), deploy history, versions, object index. */
export async function overview(env) {
	const [siteKeys, aliasKeys, deployKeys, objKeys, codeKeys] = await Promise.all(
		["site:", "alias:", "deploy:", "obj:", "code:"].map((p) => listAll(env.CODE, p)),
	);
	const aliases = await Promise.all(aliasKeys.map(async (k) => ({ host: k.name.slice(6), site: await env.CODE.get(k.name) })));
	const sites = await Promise.all(
		siteKeys.map(async (k) => {
			const id = k.name.slice(5);
			return { id, version: await env.CODE.get(k.name), aliases: aliases.filter((a) => a.site === id).map((a) => a.host) };
		}),
	);
	const deploys = await Promise.all(
		deployKeys.map(async (k) => {
			const rest = k.name.slice(7); // <site>:<iso time>~<suffix>
			const at = rest.slice(rest.indexOf(":") + 1).split("~")[0];
			return { site: rest.slice(0, rest.indexOf(":")), at, version: await env.CODE.get(k.name), ...k.metadata };
		}),
	);
	const objects = objKeys.map((k) => {
		const rest = k.name.slice(4);
		const first = rest.indexOf("|");
		const second = rest.indexOf("|", first + 1);
		return { site: rest.slice(0, first), className: rest.slice(first + 1, second), name: rest.slice(second + 1), ...k.metadata };
	});
	const versions = await Promise.all(
		codeKeys.map(async (k) => {
			const version = k.name.slice(5);
			const assets = k.metadata?.files ?? (await listAll(env.CODE, `asset:${version}:`)).length;
			return { version, assets };
		}),
	);
	return json({ sites, aliases, deploys, objects, versions });
}

/** GET /__admin/state: celld's live node counters (the only operator call made).
 *  OPERATOR_URL is the node's internal listener (production pins it to
 *  127.0.0.1:8081); `celld dev` picks a random port, so previews leave it empty. */
export async function nodeState(env) {
	if (!env.OPERATOR_URL) return fail(503, "node state is not available here (no OPERATOR_URL; e.g. celld dev)");
	try {
		const res = await fetch(`${env.OPERATOR_URL}/state`, { signal: AbortSignal.timeout(5000) });
		return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
	} catch (e) {
		return fail(502, `node state unreachable: ${String(e?.message ?? e).slice(0, 200)}`);
	}
}
