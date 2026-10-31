import { core } from "#lib/server/core.ts";
import { SESSION_COOKIE } from "#lib/server/http.ts";

const BODYLESS = new Set([101, 204, 205, 304]);

export async function handle({ event, resolve }) {
	if (event.url.pathname === "/api/health") return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
	const c = core();
	const token = event.cookies.get(SESSION_COOKIE);
	const session = c.sessionUser(token);
	event.locals.core = c;
	event.locals.user = session?.user ?? null;
	event.locals.session = session?.sessionId ?? null;
	event.locals.sessionToken = token ?? null;

	const response = await resolve(event);
	const headers = new Headers(response.headers);
	headers.set("x-content-type-options", "nosniff");
	headers.set("referrer-policy", "same-origin");
	headers.set("x-frame-options", "DENY");
	headers.set("cache-control", headers.get("cache-control") ?? "no-store");
	return new Response(BODYLESS.has(response.status) ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
