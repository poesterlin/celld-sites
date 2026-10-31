/** Wall-clock limit for a site's response (until its headers). CPU is capped
 *  separately (1 s per request); this catches code that waits forever, which would
 *  otherwise hold the visitor's connection open. Object calls get 80% of it, so the
 *  site can still answer when one of them times out. */
export const timeoutMs = (env) => (Number(env.SITE_TIMEOUT_SECS) || 30) * 1000;
export const objectTimeoutMs = (env) => Math.round(timeoutMs(env) * 0.8);

/** A positive whole-number wrangler var, clamped to max, or the default. */
export function limit(env, name, def, max) {
	const n = Number(env[name]);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
}

export class Timeout extends Error {}
export async function withTimeout(promise, ms, what) {
	let timer;
	const expired = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Timeout(`${what} did not finish within ${ms / 1000} s`)), ms);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}
