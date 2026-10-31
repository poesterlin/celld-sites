import { AuthError, safePath } from "#lib/server/core.ts";
import { FLOW_COOKIE, flowCookie, go } from "#lib/server/accounts.ts";
import { guard } from "#lib/server/http.ts";

const cookieValue = (request, name) =>
	(request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim().split("="))
		.find(([key]) => key === name)?.[1] ?? null;

/** The provider sent the browser back. The state must match the cookie set when
 *  this browser started, so nobody can finish a sign-in they started for you. */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	const params = event.url.searchParams;
	const clear = flowCookie(c, "", 0);
	const bounce = (message: string) => go(`/auth/login?error=${encodeURIComponent(message)}`, [clear]);
	if (params.get("error")) return bounce(params.get("error_description") ?? "The provider refused the sign-in.");
	const state = params.get("state") ?? "";
	if (!state || state !== cookieValue(event.request, FLOW_COOKIE)) return bounce("That sign-in did not start in this browser. Try again.");
	let out;
	try {
		out = await c.accounts.complete(event.params.provider, params);
	} catch (err) {
		if (!(err instanceof AuthError)) throw err;
		return bounce(err.message);
	}
	if (out.kind === "denied") return bounce(out.reason);
	if (out.kind === "linked") return go("/account", [clear]);
	if (out.kind === "pending") return go("/auth/pending", [clear]);
	const session = c.accounts.startSession(out.user.id, event.params.provider, event.request.headers.get("user-agent") ?? "", event.getClientAddress());
	const next = out.req ? `/auth/authorize?req=${encodeURIComponent(out.req)}` : safePath(out.next ?? "/");
	return go(next, [clear, c.sessionCookie(session.token, session.maxAge)], 303);
});
