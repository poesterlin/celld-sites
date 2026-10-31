// Calls for the Settings and Account pages: the shell's api() plus a toast on failure.
import { api } from "./api.ts";
import { oops } from "./ui.svelte.ts";

export async function call(method: string, path: string, body?: unknown): Promise<any> {
	try {
		return await api(path, { method, body });
	} catch (err) {
		oops(err);
		throw err;
	}
}

/** Epoch milliseconds as the ISO string the shared format helpers take. */
export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
