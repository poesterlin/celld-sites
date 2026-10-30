import { pkce } from "../../../../lib/oidc.ts";
import { safePath } from "#lib/server/core.ts";
import { guard } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	const state = c.token(18);
	const nonce = c.token(18);
	const { verifier, challenge } = pkce();
	c.db
		.prepare("INSERT INTO logins (state, nonce, verifier, next, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(state, nonce, verifier, safePath(event.url.searchParams.get("next") ?? "/"), Date.now());
	// The IdP is another origin: SvelteKit's redirect() refuses external URLs.
	return new Response(null, {
		status: 303,
		headers: { location: await c.oidc.authorizationUrl({ state, nonce, challenge }), "cache-control": "no-store" }
	});
});
