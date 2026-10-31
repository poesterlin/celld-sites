import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Why a hostname may not be reached, even when it is on an allowlist. Names
 *  only: an allowlisted name can still resolve to a private address (DNS
 *  rebinding), so only allowlist names whose DNS the operator controls. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".test", ".invalid", ".example", ".onion"];
/** A real top-level domain is alphabetic or punycode: `127.1`, `0x7f.1` and
 *  `1.2.3.4.5` are numeric host forms, not names to allowlist. */
const TLD = /^(?:[a-z][a-z0-9-]*|xn--[a-z0-9-]+)$/;
export function internalHost(host, adminHost) {
	if (host === adminHost) return "is the admin hostname";
	if (!host.includes(".")) return "is a single-label name";
	if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return "is an IP address";
	const suffix = INTERNAL_SUFFIXES.find((s) => host.endsWith(s));
	if (suffix) return `ends in ${suffix}`;
	if (!TLD.test(host.slice(host.lastIndexOf(".") + 1))) return "has a numeric or invalid top-level domain";
	return null;
}

/** The outbound network handed to a site with an allowlist. fetch() reaches
 *  only the hosts on it, over HTTPS on 443; everything else gets a 403 the site
 *  can read. */
export class SiteEgress extends WorkerEntrypoint<Env> {
	async fetch(request) {
		const { site, allow } = this.ctx.props;
		const deny = (why) => new Response(`egress blocked: ${why}\n`, { status: 403 });
		let url;
		try {
			url = new URL(request.url);
		} catch {
			return deny("the request URL is not valid");
		}
		// HTTPS on 443 only. Besides keeping traffic encrypted, this keeps a rebound
		// name (an allowlisted host resolving to 127.0.0.1) away from celld's
		// operator API, which speaks plain HTTP on another port.
		if (url.protocol !== "https:") return deny(`${url.protocol} is not allowed, only https:`);
		if (url.port !== "") return deny(`port ${url.port} is not allowed, only 443`);
		if (!allow.includes(url.hostname)) return deny(`${url.hostname} is not allowlisted for ${site}`);
		const internal = internalHost(url.hostname, this.env.ADMIN_HOST);
		if (internal) return deny(`${url.hostname} ${internal}`);
		try {
			// Manual redirects: the site follows them, so every hop is checked.
			return await fetch(new Request(request, { redirect: "manual" }));
		} catch (e) {
			return new Response(`egress to ${url.hostname} failed: ${String(e?.message ?? e).slice(0, 300)}\n`, { status: 502 });
		}
	}
}
