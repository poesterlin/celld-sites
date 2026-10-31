import { oops } from "@hamstr/ui/state.svelte.ts";

/** Call the JSON API; failures are shown as a toast and rethrown. */
export async function call(method: string, path: string, body?: unknown): Promise<any> {
	try {
		const res = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Error(data.error ?? `request failed (${res.status})`), { status: res.status });
		return data;
	} catch (err) {
		oops(err);
		throw err;
	}
}

export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
