import { error, isHttpError, isRedirect } from "@sveltejs/kit";
import { AuthError } from "../../../lib/core.ts";
import { core } from "./core.ts";

export const SESSION_COOKIE = "celld_auth_session";

export function cookieOptions(maxAge: number) {
	return { path: "/", httpOnly: true, secure: core().origin.startsWith("https:"), sameSite: "lax" as const, maxAge };
}

export const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Unsafe requests must come from this service's own pages. */
export function sameOrigin(event): boolean {
	const site = event.request.headers.get("sec-fetch-site");
	if (site !== null) return site === "same-origin";
	const origin = event.request.headers.get("origin");
	return origin === null || origin === core().origin;
}

interface Access {
	/** Admins and owners only. */
	admin?: boolean;
	/** No session needed (sign-in endpoints). */
	open?: boolean;
}

/** Why this request may not reach the handler, or null. */
function refusal(event, access: Access | undefined): Response | null {
	if (!["GET", "HEAD"].includes(event.request.method) && !sameOrigin(event)) return json(403, { error: "cross-site request refused" });
	if (access?.open) return null;
	const user = event.locals.user;
	if (!user) return json(401, { error: "sign in first" });
	if (access?.admin && user.role === "member") return json(403, { error: "admins only" });
	return null;
}

function failure(err): Response {
	if (isRedirect(err)) throw err;
	if (err instanceof AuthError) return json(err.status, { error: err.message });
	if (isHttpError(err)) return json(err.status, { error: err.body.message });
	console.error("auth:", err);
	return json(500, { error: "something went wrong" });
}

/** Wrap a JSON route: same-origin for unsafe methods, a signed-in person (an admin if asked), errors as JSON. */
export function api(access: Access | undefined, handler: (event, user) => unknown | Promise<unknown>) {
	return async (event) => {
		const refused = refusal(event, access);
		if (refused) return refused;
		try {
			const out = await handler(event, event.locals.user);
			return out instanceof Response ? out : json(200, out ?? { ok: true });
		} catch (err) {
			return failure(err);
		}
	};
}

export async function body(event): Promise<any> {
	const text = await event.request.text();
	if (text.length > 65536) error(413, "too large");
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		error(400, "body must be JSON");
	}
}

/** The caller's most useful identity for the audit log. */
export const actor = (user) => user.id as string;

/** SvelteKit's redirect() refuses other origins; the router and providers live elsewhere. */
export const external = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
