// HTTP helpers shared by the shell's routes: the shell's headers (including its
// CSP), JSON errors in the shape the UI expects, and the guards that keep
// unsafe requests same-origin.
import { isHttpError, isRedirect } from "@sveltejs/kit";
import { esc } from "../../../lib/html.mjs";
import { BundleError, CelldError, HttpError, ManifestError } from "./core.js";

export { esc };

/** The shell's CSP. SvelteKit appends its nonce to script-src for rendered
 *  pages; everything else gets this exact policy. */
export function csp(core) {
	return [
		"default-src 'self'",
		"img-src 'self' data:",
		"style-src 'self'",
		"script-src 'self'",
		"connect-src 'self'",
		`frame-src ${core.grainSources}`,
		"base-uri 'none'",
		// Chromium applies form-action to the redirect after a POST too, and
		// "Open as guest" redirects into the grain.
		`form-action 'self' ${core.grainSources}`,
		"frame-ancestors 'none'",
	].join("; ");
}

/** Directives that depend on runtime config and are not known at build time.
 *  Appended to the policy SvelteKit builds for rendered pages. */
export function cspExtras(core) {
	return [`frame-src ${core.grainSources}`, `form-action 'self' ${core.grainSources}`, "frame-ancestors 'none'"];
}

export function shellHeaders(core, extra = {}) {
	return {
		"x-content-type-options": "nosniff",
		// Chromium sends `Origin: null` on form posts under no-referrer, which would
		// defeat the same-origin checks below.
		"referrer-policy": "same-origin",
		"x-frame-options": "DENY",
		"content-security-policy": csp(core),
		...extra,
	};
}

export function json(core, status, body, extra = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...shellHeaders(core),
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extra,
		},
	});
}

export const fail = (core, status, message) => json(core, status, { error: message });

export function html(core, status, body, extra = {}) {
	return new Response(body, {
		status,
		headers: { ...shellHeaders(core), "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra },
	});
}

export const LOGO = `<img src="/favicon.svg" width="64" height="64" alt="">`;

/** A plain centred card, as the server renders for sign-in errors and links. */
export function page(title, body, name = "Hamstr") {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${name}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"></head>
<body class="plain"><main class="center-card">${body}</main></body></html>`;
}

/** Unsafe requests to the shell must come from the shell's own pages. */
export function sameOrigin(event, core) {
	const site = event.request.headers.get("sec-fetch-site");
	if (site !== null) return site === "same-origin";
	const origin = event.request.headers.get("origin");
	return origin === null || origin === core.shellOrigin;
}

export async function readBody(request, limit = 64 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request.body ?? []) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, "request is too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(request) {
	if (!String(request.headers.get("content-type") ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
	try {
		return JSON.parse((await readBody(request)) || "{}");
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(400, "body is not JSON");
	}
}

/** Wrap a route handler: Hamstr's own errors become `{ error }` JSON with the
 *  same statuses the plain-Node server used. SvelteKit's redirects pass through. */
export function guard(fn) {
	return async (event) => {
		const core = event.locals.core;
		try {
			return await fn(event);
		} catch (err) {
			if (isRedirect(err) || isHttpError(err)) throw err;
			const status =
				err instanceof HttpError || err instanceof CelldError
					? err.status
					: err instanceof ManifestError || err instanceof BundleError
						? 422
						: 500;
			if (status >= 500) console.error("hamstr: request failed", err);
			return fail(core, status, status === 500 ? "internal error" : err.message);
		}
	};
}

/** The signed-in user, or a 401 in the shape the UI expects. */
export function requireUser(event) {
	const user = event.locals.user;
	if (!user) throw new HttpError(401, "sign in first");
	return user;
}

/** The same-origin check the JSON API applies to every unsafe request. */
export function requireSameOrigin(event) {
	if (!sameOrigin(event, event.locals.core)) throw new HttpError(403, "cross-origin request");
}
