import { authPolicy } from "./policy.ts";
import { signTok, verifyTok } from "./tokens.ts";
import { plain } from "../lib/http.ts";
import { ownerOf } from "../lib/sites.ts";
import { serveWithLimit } from "../serve/limit.ts";

// A site can ask for sign-in with `auth` in celld.json; a deploy records that
// mode on the site (auth:<site>.declared, applied on activation, see activate),
// never on the shared code record. The sign-in service (Hamstr) can override it
// (auth:<site>.override, it wins). Either way it reduces to a mode:
//   required  no valid cookie -> send the browser to the sign-in service (AUTH_URL)
//   optional  anyone gets in; a valid cookie adds the person's headers
// The sign-in service decides WHO may enter (users, groups) before it issues the
// handoff token, so the router only verifies a signed cookie and never calls it.
// Cookies are host-only and short-lived: expiry sends the browser through the
// sign-in service again, which re-checks that the person is still allowed.
//
// Tokens are `<base64url(JSON)>.<base64url(HMAC-SHA256)>`, the format of
// hamstr/lib/auth/token.ts, keyed by AUTH_KEY. Three kinds:
//   authreq  router -> sign-in service: "this host wants a person" (carries the host,
//            site and return path; signed so a visitor cannot ask for another
//            site's policy)
//   handoff  sign-in service -> router: "this person may enter this host" (30 s)
//   site     the cookie the router sets from a handoff
// Site code never gets the key. It sees only x-celld-user-* headers, which the
// router strips from every incoming request and sets itself.
const AUTH_COOKIE = "celld_auth";
const USER_HEADER = "x-celld-user-";
const SITE_COOKIE_SECS = 900;
const AUTHREQ_SECS = 600;

/** A same-host path: "/x?y", never "//host" or "/\host". */
const safeNext = (v, fallback = "/") => (typeof v === "string" && v.length <= 2048 && /^\/(?![/\\])/.test(v) && !/[\u0000-\u001f]/.test(v) ? v : fallback);

function cookieOf(request, name) {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}
const secureCookies = (request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
// __Host- makes browsers refuse a cookie set from a sibling subdomain or with a Domain.
const cookieName = (request) => (secureCookies(request) ? `__Host-${AUTH_COOKIE}` : AUTH_COOKIE);
const cookieLine = (request, value, maxAge) =>
	`${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies(request) ? "; Secure" : ""}`;

/** Handoff tokens are single use: a link in a history or a log cannot sign anyone in again. */
const usedHandoffs = new Map(); // jti -> exp
function spendHandoff(jti, exp) {
	const now = Date.now() / 1000;
	for (const [id, until] of usedHandoffs) if (until <= now) usedHandoffs.delete(id);
	if (typeof jti !== "string" || !jti || usedHandoffs.has(jti)) return false;
	usedHandoffs.set(jti, exp);
	return true;
}

export async function signIn(request, env, ctx, site, version) {
	// Whatever the visitor sends, site code only ever sees headers set below.
	const headers = new Headers(request.headers);
	for (const name of request.headers.keys()) if (name.startsWith(USER_HEADER)) headers.delete(name);
	const policy = await authPolicy(env, site);
	if (!policy) return serveWithLimit(new Request(request, { headers }), env, ctx, site, version);
	if (!env.AUTH_KEY || !env.AUTH_URL) return plain(503, "Sign-in is not configured on this node");

	const url = new URL(request.url);
	if (url.pathname === "/.celld/auth/callback") return authCallback(request, env, url);
	if (url.pathname === "/.celld/auth/logout") return authLogout(request, env, url);
	const raw = cookieOf(request, cookieName(request));
	const user = raw ? await verifyTok(env.AUTH_KEY, raw, "site", url.hostname) : null;
	if (url.pathname === "/.celld/auth/me") return noStoreJson({ user: user ? publicUser(user) : null, mode: policy.mode });
	if (!user && policy.mode === "required") return askToSignIn(request, env, url, site);
	forwardIdentity(request, headers, user);
	return serveWithLimit(new Request(request, { headers }), env, ctx, site, version);
}

const noStoreJson = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authLogout(request, env, url) {
	return new Response(null, {
		status: 303,
		headers: { location: `${env.AUTH_URL}/logout?host=${encodeURIComponent(url.hostname)}`, "set-cookie": cookieLine(request, "", 0), "cache-control": "no-store" },
	});
}

/** A page load goes to the sign-in service; anything else (fetch, images, POST) gets a 401. */
async function askToSignIn(request, env, url, site) {
	const dest = request.headers.get("sec-fetch-dest") ?? "";
	const wantsJson = (request.headers.get("accept") ?? "").startsWith("application/json");
	const navigation = (request.method === "GET" || request.method === "HEAD") && !/^(empty|script|style|image|font)$/.test(dest) && !wantsJson;
	if (!navigation) return plain(401, "Sign in required", { "www-authenticate": `Login realm="${url.hostname}"` });
	const req = await signTok(env.AUTH_KEY, { typ: "authreq", aud: url.hostname, site: ownerOf(site), next: safeNext(url.pathname + url.search), exp: Math.floor(Date.now() / 1000) + AUTHREQ_SECS });
	return new Response(null, { status: 302, headers: { location: `${env.AUTH_URL}/authorize?req=${req}`, "cache-control": "no-store" } });
}

/** Drop the session cookie (the site does not need it) and add the person's headers. */
function forwardIdentity(request, headers, user) {
	const rest = (headers.get("cookie") ?? "")
		.split(";")
		.filter((c) => c.trim() && c.trim().split("=")[0] !== cookieName(request))
		.join(";");
	if (rest) headers.set("cookie", rest);
	else headers.delete("cookie");
	if (!user) return;
	const u = publicUser(user);
	headers.set(`${USER_HEADER}id`, u.id);
	headers.set(`${USER_HEADER}name`, encodeURIComponent(u.name));
	if (u.email) headers.set(`${USER_HEADER}email`, encodeURIComponent(u.email));
	headers.set(`${USER_HEADER}groups`, u.groups.map(encodeURIComponent).join(","));
	headers.set(`${USER_HEADER}role`, u.role);
}

const publicUser = (t) => ({
	id: String(t.sub ?? ""),
	name: String(t.name ?? ""),
	email: typeof t.email === "string" ? t.email : null,
	groups: Array.isArray(t.groups) ? t.groups.map(String) : [],
	role: t.role === "owner" || t.role === "admin" ? t.role : "member",
});

async function authCallback(request, env, url) {
	const host = url.hostname;
	const handoff = await verifyTok(env.AUTH_KEY, url.searchParams.get("token"), "handoff", host);
	if (!handoff || !spendHandoff(handoff.jti, handoff.exp)) {
		return plain(400, "That sign-in link is invalid or has expired. Open the site again to sign in.");
	}
	const { typ, aud, exp, jti, ...claims } = handoff;
	const site = await signTok(env.AUTH_KEY, { ...claims, typ: "site", aud: host, exp: Math.floor(Date.now() / 1000) + SITE_COOKIE_SECS });
	return new Response(null, {
		status: 303,
		headers: { location: safeNext(url.searchParams.get("next")), "set-cookie": cookieLine(request, site, SITE_COOKIE_SECS), "cache-control": "no-store" },
	});
}
