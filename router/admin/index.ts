import { alias } from "./alias.ts";
import { deleteAuth, getAuth, putAuth } from "./auth.ts";
import { dumpSite, restoreSite } from "./backup.ts";
import { adminCall } from "./call.ts";
import { check } from "./check.ts";
import { activate, missingBlobs, putBlob, putCode, stageVersion } from "./deploy.ts";
import { deleteEgress, getEgress, putEgress } from "./egress.ts";
import { nodeState, overview } from "./overview.ts";
import { prune } from "./prune.ts";
import { deleteSite } from "./site.ts";
import { bearerMatches, fail } from "../lib/http.ts";

/** The admin API. Writes need the deploy token; the read-only GETs also accept the read token. */
export async function admin(request, env, ctx, url) {
	const { pathname } = url;
	const method = request.method;
	const isAdmin = await bearerMatches(request, env.ADMIN_TOKEN_SHA256);
	if (method === "GET" && (pathname === "/__admin/overview" || pathname === "/__admin/state")) {
		if (!isAdmin && !(await bearerMatches(request, env.READ_TOKEN_SHA256))) return fail(403, "forbidden");
		return pathname === "/__admin/overview" ? overview(env) : nodeState(env);
	}
	if (!isAdmin) return fail(403, "forbidden");
	if (method === "PUT" && pathname === "/__admin/blob") return putBlob(request, env, url);
	if (method === "POST" && pathname === "/__admin/blobs/missing") return missingBlobs(request, env);
	if (method === "PUT" && pathname === "/__admin/code") return putCode(request, env, url);
	if (method === "POST" && pathname === "/__admin/activate") return activate(env, url);
	if (method === "POST" && pathname === "/__admin/stage") return stageVersion(env, url);
	if (method === "POST" && pathname === "/__admin/check") return check(env, ctx, url);
	if ((method === "PUT" || method === "DELETE") && pathname === "/__admin/alias") return alias(request, env, url);
	if (method === "POST" && pathname === "/__admin/prune") return prune(env, url);
	if (method === "DELETE" && pathname === "/__admin/site") return deleteSite(env, url);
	if (method === "POST" && pathname === "/__admin/call") return adminCall(request, env, url);
	if (method === "GET" && pathname === "/__admin/dump") return dumpSite(env, ctx, url);
	if (method === "POST" && pathname === "/__admin/restore") return restoreSite(request, env, url);
	if (pathname === "/__admin/auth") {
		if (method === "GET") return getAuth(env, url);
		if (method === "PUT") return putAuth(request, env, url);
		if (method === "DELETE") return deleteAuth(env, url);
	}
	if (pathname === "/__admin/egress") {
		if (method === "GET") return getEgress(env, url);
		if (method === "PUT") return putEgress(request, env, url);
		if (method === "DELETE") return deleteEgress(env, url);
	}
	return fail(404, "not found");
}
