import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

async function post(path: string, body?: unknown) {
	const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? "that did not work");
	return data;
}

const ask = async <T>(run: () => Promise<T>): Promise<T> => {
	if (!browserSupportsWebAuthn()) throw new Error("this browser has no passkey support");
	try {
		return await run();
	} catch (err) {
		throw new Error(err?.name === "NotAllowedError" ? "the passkey was cancelled" : (err?.message ?? String(err)));
	}
};

/** Sign in with a passkey; returns where to go next. */
export async function passkeyLogin(req: string | null): Promise<string> {
	const { key, publicKey } = await post("/passkey/login/options");
	const response = await ask(() => startAuthentication({ optionsJSON: publicKey }));
	return (await post("/passkey/login", { key, req, response })).next;
}

/** Add a passkey to the signed-in person. */
export async function passkeyAdd(label: string): Promise<void> {
	const { key, publicKey } = await post("/api/account/passkeys/options");
	const response = await ask(() => startRegistration({ optionsJSON: publicKey }));
	await post("/api/account/passkeys", { key, label, response });
}
