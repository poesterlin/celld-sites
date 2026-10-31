import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { loadSite } from "../isolate/load.ts";
import { listAll } from "../lib/util.ts";

/** One per (site, class, name): runs the site's class as a facet. */
export class SiteObject extends DurableObject<Env> {
	version?: string;
	tag?: string;
	state?: any;

	/** Atomically claim a slot in `site`'s object quota. The instance is keyed
	 *  `~quota~|site` (site ids are hostnames, so no site object can collide with
	 *  it), and its SQLite database is the counter. On first use it seeds from the
	 *  existing object index, so objects created before quotas still count. */
	async claim(site, key, max) {
		return this.ctx.blockConcurrencyWhile(async () => {
			const sql = this.ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS claimed (k TEXT PRIMARY KEY)");
			sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
			if (sql.exec("SELECT 1 FROM claimed WHERE k = ?", key).toArray().length) return true;
			if (!sql.exec("SELECT 1 FROM meta WHERE k = 'seeded'").toArray().length) {
				for (const k of await listAll(this.env.CODE, `obj:${site}|`)) sql.exec("INSERT OR IGNORE INTO claimed (k) VALUES (?)", k.name.slice(4));
				sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', ?)", new Date().toISOString());
			}
			const count = sql.exec("SELECT count(*) AS c FROM claimed").toArray()[0].c;
			if (count >= max) return false;
			sql.exec("INSERT INTO claimed (k) VALUES (?)", key);
			return true;
		});
	}

	/** Delete the quota counter of a deleted site. */
	async clear() {
		await this.ctx.storage.deleteAll();
	}

	/** Abort this object's facet without waiting for its next call. Used when a
	 *  site's egress allowlist changes: a facet keeps the outbound network it was
	 *  loaded with, and pending timers would otherwise keep using it. */
	async rearm(className) {
		try {
			this.ctx.facets.abort(className, new Error("egress allowlist changed"));
		} catch {}
		this.version = undefined;
		this.tag = undefined;
	}

	async handle(site, version, tag, allow, className, method, args) {
		const worker = await loadSite(this.env, this.ctx.exports, site, version, { allow, tag });
		// A redeploy and an egress allowlist change both hand the site a different
		// isolate. Data survives (the facet's name selects the database); a running
		// facet must not keep the outbound network it was created with, or removing
		// an allowlist would not stop an app that is already talking to it.
		const redeployed = this.version !== undefined && this.version !== version;
		const egressChanged = this.tag !== undefined && this.tag !== tag;
		if (redeployed || egressChanged) this.ctx.facets.abort(className, new Error(redeployed ? "site redeployed" : "egress allowlist changed"));
		this.version = version;
		this.tag = tag;
		const facet = this.ctx.facets.get(className, () => ({ class: worker.getDurableObjectClass(className) }));
		return facet[method](...args);
	}

	/** Delete this object's data: the site class's facet database, then our own. */
	async destroy(className) {
		this.ctx.facets.delete(className);
		this.version = undefined;
		await this.ctx.storage.deleteAll();
	}
}
