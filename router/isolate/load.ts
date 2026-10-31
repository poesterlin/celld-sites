import { egressFor } from "../egress/cache.ts";
import { codeFor } from "./code.ts";
import { DATA } from "./data.ts";
import { MAIN, PRELUDE } from "./prelude.ts";
import { limit } from "../lib/limits.ts";
import { isScratch } from "../lib/sites.ts";

/** Load (or reuse) the isolate for one version of a site. The code is read in the
 *  calling request and the loader gets it synchronously: with an async callback,
 *  concurrent first requests waited on the load the first one started, and
 *  celld 0.6.3 dropped their responses (denoland/celld#258), so they hung until
 *  the 504. */
export async function loadSite(env: any, exports: any, site: string, version: string, egress?: { allow?: string[]; tag?: string }): Promise<any> {
	const { allow, tag } = egress ?? (await egressFor(env, site));
	const code = await codeFor(env, version);
	return env.LOADER.get(`${site}@${version}${tag}`, () => {
		return {
			compatibilityDate: code.compatibilityDate,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: { "main.js": MAIN, "prelude.js": PRELUDE, "celld-data.js": DATA, "worker.js": code.source },
			env: {
				ASSETS: exports.SiteAssets({ props: { version } }),
				// A scratch site has no active version, so its objects run the checked one.
				OBJECTS: exports.SiteObjects({ props: isScratch(site) ? { site, version } : { site } }),
			},
			// No allowlist: fetch() throws. Otherwise the proxy below decides.
			globalOutbound: allow.length ? exports.SiteEgress({ props: { site, allow } }) : null,
			// One second of CPU per request, and a cap on subrequests (Durable
			// Object calls, egress fetches) so one request cannot fan out without
			// bound. Cloudflare's paid limit is 1000; override with a wrangler var.
			limits: { cpuMs: 1000, subRequests: limit(env, "SITE_MAX_SUBREQUESTS", 1000, 10000) },
		};
	});
}
