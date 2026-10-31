export const json = (body, status = 200) => Response.json(body, { status });
export const fail = (status, error) => json({ error }, status);

/** True if the request's bearer token hashes (SHA-256) to `expectedHex`. Only the
 *  hashes are deployment vars, so the bucket never stores a usable token. */
export async function bearerMatches(request, expectedHex) {
	const auth = request.headers.get("authorization") ?? "";
	if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex) || !auth.startsWith("Bearer ")) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7))));
	const expected = Uint8Array.from(expectedHex.match(/../g) ?? [], (h) => parseInt(String(h), 16));
	return (crypto.subtle as any).timingSafeEqual(digest, expected);
}

/** Reject a body before reading it if it is larger than `max` bytes. */
export function tooLarge(request, max) {
	const length = Number(request.headers.get("content-length"));
	if (!Number.isFinite(length) || request.headers.get("content-length") === null) return fail(411, "content-length required");
	if (length > max) return fail(413, `body is ${length} bytes, limit ${max}`);
	return null;
}

export async function tokenMatches(token, expectedHex) {
	if (token === null || !expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	const expected = Uint8Array.from(expectedHex.match(/../g) ?? [], (h) => parseInt(String(h), 16));
	return (crypto.subtle as any).timingSafeEqual(digest, expected);
}

/** The request body as JSON, or undefined when it is not JSON. */
export async function jsonOrUndefined(request) {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

export const plain = (status, text, headers = {}) => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
