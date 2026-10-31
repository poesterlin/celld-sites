// Route helpers for accounts (lib/auth): the JSON API wrapper for the Settings
// and Account pages, and the redirects and cookies of signing in.
import { AuthError } from "./core.ts";
import { guard, json, readJson, sameOrigin } from "./http.ts";

interface Access {
	/** Admins and owners only. */
	admin?: boolean;
	/** No session needed (sign-in endpoints). */
	open?: boolean;
}

/** Why this request may not reach the handler, or null. */
function refusal(event, access: Access | undefined): Response | null {
	const c = event.locals.core;
	if (!["GET", "HEAD"].includes(event.request.method) && !sameOrigin(event, c)) return json(c, 403, { error: "cross-origin request" });
	if (access?.open) return null;
	const user = event.locals.user;
	if (!user) return json(c, 401, { error: "sign in first" });
	if (access?.admin && !c.isAdmin(user)) return json(c, 403, { error: "only an admin can do that" });
	return null;
}

/** A JSON route over the accounts module: `handler(event, user, accounts)`. */
export function accountsApi(access: Access | undefined, handler: (event, user, accounts) => unknown) {
	return guard(async (event) => {
		const c = event.locals.core;
		const refused = refusal(event, access);
		if (refused) return refused;
		try {
			const out = await handler(event, event.locals.user, c.accounts);
			return out instanceof Response ? out : json(c, 200, out ?? { ok: true });
		} catch (err) {
			if (err instanceof AuthError) return json(c, err.status, { error: err.message });
			throw err;
		}
	});
}

export const body = (event) => readJson(event.request);

/** A redirect anywhere (SvelteKit's redirect() refuses other origins), with cookies. */
export function go(location: string, cookies: string[] = [], status = 302) {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status, headers });
}

/** Binds a provider sign-in to this browser (see the callback). */
export const FLOW_COOKIE = "hamstr_flow";
export const flowCookie = (c, value: string, maxAge = 600) => `${FLOW_COOKIE}=${value}; ${c.cookieAttrs}; Max-Age=${maxAge}`;
