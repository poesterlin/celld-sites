import { WorkerEntrypoint } from "cloudflare:workers";
import { egressFor } from "../egress/cache.ts";
import type { Env } from "../env.ts";
import { objectTimeoutMs, withTimeout } from "../lib/limits.ts";
import { isScratch } from "../lib/sites.ts";
import { FORBIDDEN_NAMES, RESERVED_METHOD } from "./names.ts";
import { MAX_INDEXED, claimObject, indexObject, indexed } from "./registry.ts";

/** The OBJECTS binding handed to each site: `call(className, name, method, ...args)`
 *  runs an RPC method on that site's object. Arguments and results must be
 *  structured-cloneable (plain data). */
export class SiteObjects extends WorkerEntrypoint<Env> {
	async call(className, name, method, ...args) {
		const { site } = this.ctx.props;
		const ident = /^[A-Za-z_$][\w$]*$/;
		if (!ident.test(className) || !ident.test(method) || className.length > 128 || method.length > 128 || typeof name !== "string" || !name || name.length > 200) {
			throw new Error("bad object reference");
		}
		// Names inherited from Object.prototype resolve through the site's exports
		// (`getDurableObjectClass("constructor")` is the DurableObjectState, and
		// `facet["toString"]` is a prototype method). They are never site classes.
		if (FORBIDDEN_NAMES.has(className) || FORBIDDEN_NAMES.has(method) || RESERVED_METHOD.test(method)) throw new Error("bad object reference");
		const key = `${site}|${className}|${name}`;
		// celld KV keys are limited to 512 bytes; a longer key would surface as an
		// internal KV error instead of a bad reference.
		if (new TextEncoder().encode(key).length > 500) throw new Error("bad object reference");
		const version = this.ctx.props.version ?? (await this.env.CODE.get(`site:${site}`));
		// A site deleted while one of its requests was still running.
		if (version === null) throw new Error("site not found");
		// The check deletes its scratch objects through the index, so record them first.
		if (isScratch(site)) await indexObject(this.env, key);
		else if (!indexed.has(key)) {
			await claimObject(this.env, site, key);
			this.ctx.waitUntil(
				indexObject(this.env, key).then(() => {
					if (indexed.size >= MAX_INDEXED) indexed.clear();
					indexed.add(key);
				}),
			);
		}
		const { allow, tag } = await egressFor(this.env, site);
		const call = this.env.SITE_OBJECTS.getByName(key).handle(site, version, tag, allow, className, method, args);
		return withTimeout(call, objectTimeoutMs(this.env), `${className}.${method}`);
	}
}
