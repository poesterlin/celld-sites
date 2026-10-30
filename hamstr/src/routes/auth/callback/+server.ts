import { OidcError } from "../../../../lib/oidc.ts";
import { esc, guard, html, page } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	const url = event.url;
	const state = url.searchParams.get("state") ?? "";
	const login = c.db.prepare("DELETE FROM logins WHERE state = ? RETURNING *").get(state);
	if (!login || login.created_at < Date.now() - c.LOGIN_MS) {
		const body = `<h1>That sign-in expired</h1><p class="dim">Please start again.</p><p><a class="button" href="/auth/login">Sign in</a></p>`;
		return html(c, 400, page("Sign-in expired", body));
	}
	if (url.searchParams.get("error")) {
		const body = `<h1>Sign-in didn't finish</h1><p class="dim">${esc(url.searchParams.get("error"))}</p><p><a class="button" href="/auth/login">Try again</a></p>`;
		return html(c, 403, page("Sign-in cancelled", body));
	}

	let claims;
	try {
		claims = await c.oidc.finish({ code: url.searchParams.get("code") ?? "", verifier: login.verifier, nonce: login.nonce });
	} catch (err) {
		if (!(err instanceof OidcError)) throw err;
		console.error("hamstr: sign-in failed", err.message);
		const body = `<h1>Sign-in failed</h1><p class="dim">${esc(err.message)}</p><p><a class="button" href="/auth/login">Try again</a></p>`;
		return html(c, 502, page("Sign-in failed", body));
	}

	const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
	const handle = typeof claims.username === "string" ? claims.username : typeof claims.preferred_username === "string" ? claims.preferred_username : null;
	const profile = { sub: claims.sub, email, login: handle };
	if (c.config.allowed.length && !c.matches(c.config.allowed, profile) && !c.matches(c.config.admins, profile)) {
		const body = `<h1>You're not on the list</h1><p class="dim">This ${c.NAME} only lets in invited people. Ask its owner to add ${esc(email ?? handle ?? "you")}.</p>`;
		return html(c, 403, page("Not invited", body));
	}

	const name = String(claims.name || handle || (email ? email.split("@")[0] : "") || "Someone").slice(0, 80);
	const user = c.tx(() => {
		const existing = c.q.userBySub.get(claims.sub);
		if (existing) {
			c.db.prepare("UPDATE users SET name = ?, email = ?, login = ?, seen_at = ? WHERE id = ?").run(name, email, handle, c.now(), existing.id);
			return existing;
		}
		const id = c.randomId(16);
		c.db.prepare("INSERT INTO users (id, sub, name, email, login, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, claims.sub, name, email, handle, c.now(), c.now());
		return { id };
	});
	const value = c.token(32);
	c.db.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(c.sha256(value), user.id, Date.now(), Date.now() + c.SESSION_MS);

	return new Response(null, {
		status: 303,
		headers: {
			location: login.next,
			"cache-control": "no-store",
			"set-cookie": `${c.SHELL_COOKIE}=${value}; ${c.cookieAttrs}; Max-Age=${c.SESSION_MS / 1000}`
		}
	});
});
