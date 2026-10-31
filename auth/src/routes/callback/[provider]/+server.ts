import { redirect } from "@sveltejs/kit";
import { AuthError } from "../../../../lib/core.ts";
import { cookieOptions, SESSION_COOKIE } from "#lib/server/http.ts";

export async function GET({ params, url, locals, cookies, request, getClientAddress }) {
	const bounce = (message: string) => redirect(302, `/login?error=${encodeURIComponent(message)}`);
	const state = url.searchParams.get("state") ?? "";
	const bound = cookies.get("celld_auth_flow");
	cookies.delete("celld_auth_flow", { path: "/" });
	if (url.searchParams.get("error")) bounce(url.searchParams.get("error_description") ?? "The provider refused the sign-in.");
	if (!state || state !== bound) bounce("That sign-in did not start in this browser. Try again.");
	let out;
	try {
		out = await locals.core.complete(params.provider, url.searchParams);
	} catch (err) {
		if (!(err instanceof AuthError)) console.error("auth: callback", err);
		bounce(err instanceof AuthError ? err.message : "The provider's answer could not be checked.");
	}
	if (out.kind === "denied") bounce(out.reason);
	if (out.kind === "linked") redirect(302, "/account");
	if (out.kind === "pending") redirect(302, "/pending");
	const session = locals.core.startSession(out.user.id, params.provider, request.headers.get("user-agent") ?? "", getClientAddress());
	cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.maxAge));
	redirect(302, out.req ? `/authorize?req=${encodeURIComponent(out.req)}` : "/");
}
