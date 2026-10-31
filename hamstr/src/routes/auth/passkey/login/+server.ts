import { safePath } from "#lib/server/core.ts";
import { accountsApi, body } from "#lib/server/accounts.ts";
import { json } from "#lib/server/http.ts";

export const POST = accountsApi({ open: true }, async (event, _user, accounts) => {
	const c = event.locals.core;
	const { key, response, req, next } = await body(event);
	const user = await accounts.passkeyLogin(String(key), response);
	const session = accounts.startSession(user.id, "passkey", event.request.headers.get("user-agent") ?? "", event.getClientAddress());
	const to = typeof req === "string" && req ? `/auth/authorize?req=${encodeURIComponent(req)}` : safePath(typeof next === "string" ? next : "/");
	const res = json(c, 200, { next: to });
	res.headers.append("set-cookie", c.sessionCookie(session.token, session.maxAge));
	return res;
});
