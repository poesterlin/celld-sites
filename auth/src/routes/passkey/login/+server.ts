import { api, body, cookieOptions, SESSION_COOKIE } from "#lib/server/http.ts";

export const POST = api({ open: true }, async (event) => {
	const { key, response, req } = await body(event);
	const c = event.locals.core;
	const user = await c.passkeyLogin(String(key), response);
	const session = c.startSession(user.id, "passkey", event.request.headers.get("user-agent") ?? "", event.getClientAddress());
	event.cookies.set(SESSION_COOKIE, session.token, cookieOptions(session.maxAge));
	return { next: typeof req === "string" && req ? `/authorize?req=${encodeURIComponent(req)}` : "/" };
});
