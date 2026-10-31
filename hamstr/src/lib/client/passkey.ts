import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

async function post(path: string, body?: unknown) {
	const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? "that did not work");
	return data;
}

const UNKNOWN = "that passkey is not registered here";

const ask = async <T>(run: () => Promise<T>): Promise<T> => {
	if (!browserSupportsWebAuthn()) throw new Error("this browser has no passkey support");
	try {
		return await run();
	} catch (err) {
		throw new Error(err?.name === "NotAllowedError" ? "the passkey was cancelled" : (err?.message ?? String(err)));
	}
};

/** Sign in with a passkey; returns where to go next. */
export async function passkeyLogin(target: { req?: string | null; next?: string }): Promise<string> {
	const { key, publicKey } = await post("/auth/passkey/login/options");
	const response = await ask(() => startAuthentication({ optionsJSON: publicKey }));
	try {
		return (await post("/auth/passkey/login", { key, response, ...target })).next;
	} catch (err) {
		// A passkey the server never stored (e.g. saved by a registration that then
		// failed): ask the browser to drop it so it stops being offered.
		if (err.message === UNKNOWN) {
			await (PublicKeyCredential as any).signalUnknownCredential?.({ rpId: publicKey.rpId, credentialId: response.id }).catch(() => {});
			throw new Error(`${UNKNOWN}. It was probably saved by an attempt that failed; delete it from your password manager, then try again or use another sign-in method`);
		}
		throw err;
	}
}

/** Add a passkey to the signed-in person. */
export async function passkeyAdd(label: string): Promise<void> {
	const { key, publicKey } = await post("/api/account/passkeys/options");
	const response = await ask(() => startRegistration({ optionsJSON: publicKey }));
	try {
		await post("/api/account/passkeys", { key, label, response });
	} catch (err) {
		// The browser already saved it; don't leave a passkey the server never stored.
		await (PublicKeyCredential as any).signalUnknownCredential?.({ rpId: publicKey.rpId, credentialId: response.id }).catch(() => {});
		throw err;
	}
}
