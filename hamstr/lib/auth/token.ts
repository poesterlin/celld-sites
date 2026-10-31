// Signed tokens shared by Hamstr's accounts and the celld router. A token is
// `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`; the payload always
// carries `typ` (what the token is for), `aud` (the hostname it is for) and
// `exp` (seconds). Both sides hold the same key, so only code the operator runs
// can mint one; site code never sees it. The router verifies the same format
// with WebCrypto (router/auth/tokens.ts), so keep the two in step.
import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenType = "authreq" | "handoff" | "site";

export interface TokenPayload {
	typ: TokenType;
	aud: string;
	exp: number;
	[claim: string]: unknown;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

export function signToken(key: string, payload: TokenPayload): string {
	const body = b64url(JSON.stringify(payload));
	return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The payload if the signature, type, audience and expiry all hold, else null. */
export function verifyToken(key: string, token: unknown, expect: { typ: TokenType; aud?: string; now?: number }): TokenPayload | null {
	if (typeof token !== "string" || token.length > 4096) return null;
	const dot = token.indexOf(".");
	if (dot < 1 || token.indexOf(".", dot + 1) !== -1) return null;
	const body = token.slice(0, dot);
	const want = createHmac("sha256", key).update(body).digest();
	const got = Buffer.from(token.slice(dot + 1), "base64url");
	if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
	let payload: TokenPayload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== "object" || payload.typ !== expect.typ) return null;
	if (expect.aud !== undefined && payload.aud !== expect.aud) return null;
	const now = expect.now ?? Math.floor(Date.now() / 1000);
	if (typeof payload.exp !== "number" || payload.exp <= now) return null;
	return payload;
}

/** A relative path that stays on the same host: "/x?y", never "//host" or "/\host". */
export function safeNext(value: unknown, fallback = "/"): string {
	if (typeof value !== "string" || value.length > 2048) return fallback;
	if (!/^\/(?![/\\])/.test(value) || /[\u0000-\u001f]/.test(value)) return fallback;
	return value;
}
