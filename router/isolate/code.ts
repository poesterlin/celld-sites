/** Code records of recently used versions (LRU), so a warm request needs no KV
 *  read. Bounded by bytes: the router isolate's heap is limited to 128 MiB and an
 *  EmDash site's code is ~8 MB. Values only, never a promise another request is
 *  waiting on (see loadSite). */
export const codes = new Map(); // version -> code record
const CODE_CACHE_BYTES = 24 * 1024 * 1024;
let codeBytes = 0;
const codeSize = (code) => (code.source?.length ?? 0) + 1024;
export async function codeFor(env, version) {
	let code = codes.get(version);
	if (code) {
		codes.delete(version); // most recently used goes last
		codes.set(version, code);
		return code;
	}
	code = await env.CODE.get(`code:${version}`, "json");
	const size = codeSize(code);
	if (size <= CODE_CACHE_BYTES / 2 && !codes.has(version)) {
		for (const [v, c] of codes) {
			if (codeBytes + size <= CODE_CACHE_BYTES) break;
			codes.delete(v);
			codeBytes -= codeSize(c);
		}
		codes.set(version, code);
		codeBytes += size;
	}
	return code;
}
