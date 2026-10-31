const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (text) => Uint8Array.from(atob(String(text).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKeys = new Map();
const hmacKey = async (secret) => {
	let key = hmacKeys.get(secret);
	if (!key) {
		key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
		hmacKeys.set(secret, key);
	}
	return key;
};
export async function signTok(secret, payload) {
	const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
	return `${body}.${b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)))}`;
}
export async function verifyTok(secret, token, typ, aud) {
	if (typeof token !== "string" || token.length > 4096) return null;
	const dot = token.indexOf(".");
	if (dot < 1 || token.indexOf(".", dot + 1) !== -1) return null;
	try {
		const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(token.slice(dot + 1)), new TextEncoder().encode(token.slice(0, dot)));
		if (!ok) return null;
		const payload = JSON.parse(new TextDecoder().decode(unb64u(token.slice(0, dot))));
		if (!payload || payload.typ !== typ || payload.aud !== aud || typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) return null;
		return payload;
	} catch {
		return null;
	}
}
