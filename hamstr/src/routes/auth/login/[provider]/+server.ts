import { AuthError } from "#lib/server/core.ts";
import { flowCookie, go } from "#lib/server/accounts.ts";
import { guard } from "#lib/server/http.ts";

/** Send the browser to a provider. `?req` continues a celld site's sign-in,
 *  `?next` a Hamstr page, `?invite` claims an invite, `?link=1` adds the
 *  provider to the signed-in person. */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	const p = event.url.searchParams;
	const link = p.get("link") === "1";
	if (link && !event.locals.user) return go("/auth/login");
	let target: string;
	try {
		target = await c.accounts.begin(event.params.provider, { req: p.get("req"), next: p.get("next"), invite: p.get("invite"), link: link ? event.locals.user.id : null });
	} catch (err) {
		if (!(err instanceof AuthError)) console.error("hamstr: sign-in start failed", err);
		const message = err instanceof AuthError ? err.message : "That provider could not be reached.";
		return go(`/auth/login?error=${encodeURIComponent(message)}`);
	}
	return go(target, [flowCookie(c, new URL(target).searchParams.get("state") ?? "")]);
});
