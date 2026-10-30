// The store's JSON API, same origin. Everything it returns is publisher data:
// Svelte escapes text, and links only use http(s) values the server validated.
export interface ApiOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export async function api(path: string, { method = "GET", body, headers = {} }: ApiOptions = {}): Promise<any> {
	const res = await fetch(path, {
		method,
		headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let data: any = {};
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		const err = Object.assign(new Error(data.error || `Something went wrong (${res.status})`), { status: res.status });
		throw err;
	}
	return data;
}

export const latestRelease = (detail: any): any => detail?.releases?.find((r: any) => r.status === "published") ?? null;
