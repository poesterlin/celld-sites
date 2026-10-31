/** Every key under a prefix, following list cursors. */
export async function listAll(kv, prefix) {
	const keys = [];
	let cursor;
	do {
		const page = await kv.list({ prefix, cursor });
		keys.push(...page.keys);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return keys;
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
