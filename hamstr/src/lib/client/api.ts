// The shell's JSON API client. Same behaviour as before: JSON in and out,
// `{ error }` out on failure, and an expired session goes back to the welcome.
export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface ApiOptions {
	method?: string;
	body?: unknown;
}

export async function api(path: string, { method = "GET", body }: ApiOptions = {}): Promise<any> {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	let data: any = {};
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		if (res.status === 401 && typeof window !== "undefined") window.location.assign("/");
		throw new ApiError(res.status, data.error || `Something went wrong (${res.status})`);
	}
	return data;
}
