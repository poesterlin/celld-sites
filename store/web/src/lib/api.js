// The store's JSON API, same origin. Everything it returns is publisher data:
// Svelte escapes text, and links only use http(s) values the server validated.
export async function api(path, { method = "GET", body, headers = {} } = {}) {
	const res = await fetch(path, {
		method,
		headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let data = {};
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		const err = new Error(data.error || `Something went wrong (${res.status})`);
		err.status = res.status;
		throw err;
	}
	return data;
}

export const latestRelease = (detail) => detail?.releases?.find((r) => r.status === "published") ?? null;
