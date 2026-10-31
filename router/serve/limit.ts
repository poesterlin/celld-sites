import { limit } from "../lib/limits.ts";
import { serve } from "./serve.ts";

/** Requests one site may have in flight (started, not yet answered) in this
 *  router isolate. Per site, so a flooded site gets 503s instead of starving
 *  every other site on the node. Static files never reach the isolate. */
const inflight = new Map(); // site -> number
export async function serveWithLimit(request, env, ctx, site, version) {
	const max = limit(env, "SITE_MAX_INFLIGHT", 128, 10000);
	const now = inflight.get(site) ?? 0;
	if (now >= max) {
		return new Response("too many concurrent requests for this site\n", {
			status: 503,
			headers: { "retry-after": "1", "content-type": "text/plain; charset=utf-8" },
		});
	}
	inflight.set(site, now + 1);
	try {
		return await serve(request, env, ctx, site, version);
	} finally {
		const left = (inflight.get(site) ?? 1) - 1;
		if (left <= 0) inflight.delete(site);
		else inflight.set(site, left);
	}
}
