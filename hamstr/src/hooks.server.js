// One process answers two kinds of hostname:
//   HAMSTR_HOST            the shell: UI, JSON API, sign-in, share links
//   grain-<id>.<domain>    a grain: /.hamstr/enter, then everything is proxied
// Anything else is not ours. This hook routes on the Host header before
// SvelteKit's router, and adds the shell's security headers to every answer.
import { core } from "#lib/server/instance.js";
import { csp, cspExtras, json } from "#lib/server/http.js";
import { grainRequest } from "../lib/proxy.mjs";

const BODYLESS = new Set([101, 204, 205, 304]);

function withShellHeaders(c, response) {
	const headers = new Headers(response.headers);
	headers.set("x-content-type-options", "nosniff");
	// Chromium sends `Origin: null` on form posts under no-referrer, which would
	// defeat the same-origin checks. Share links opt out with their own value.
	if (!headers.has("referrer-policy")) headers.set("referrer-policy", "same-origin");
	headers.set("x-frame-options", "DENY");
	const existing = headers.get("content-security-policy");
	if (!existing) headers.set("content-security-policy", csp(c));
	else if (!existing.includes("frame-src")) headers.set("content-security-policy", `${existing}; ${cspExtras(c).join("; ")}`);
	return new Response(BODYLESS.has(response.status) ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function handle({ event, resolve }) {
	const c = core();
	event.locals.core = c;
	event.locals.user = null;
	event.locals.session = null;

	const host = (event.request.headers.get("host") ?? "")
		.toLowerCase()
		.replace(/:\d+$/, "");
	const grain = c.grainPattern.exec(host);
	if (grain) return grainRequest(event, grain[1]);
	if (host !== c.config.shellHost) {
		if (event.url.pathname === "/api/health") return json(c, 200, { ok: true });
		return new Response("unknown host\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	}

	const session = c.sessionFor(event.request);
	event.locals.session = session;
	event.locals.user = session?.user ?? null;

	return withShellHeaders(c, await resolve(event));
}
