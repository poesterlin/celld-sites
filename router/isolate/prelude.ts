// Runs in each site isolate before the site's own code, papering over APIs that
// celld 0.6.3 exposes but that throw "not implemented":
//  - console.createTask: libraries that feature-detect it (Nitro's hookable, so
//    every Nuxt site) then fail on every request. Removing it makes them take
//    their fallback path.
//  - process.nextTick: throws in celld. Nuxt/Nitro's process polyfill copies
//    nextTick from the global process object, and h3 then fails per request.
//    It is replaced with a queueMicrotask-based version.
//  - setImmediate: the global works today; a setTimeout-based stand-in is
//    installed only if it ever does not (Nitro prefers an existing global).
// The prelude must not import node:* modules: doing so breaks the site's own
// named imports from them ("does not provide an export named ...").
export const PRELUDE = `
try { console.createTask?.("celld"); } catch {
	try { console.createTask = undefined; } catch {}
	if (console.createTask) Object.defineProperty(console, "createTask", { value: undefined, configurable: true, writable: true });
}

const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const replace = (obj, name, value) => {
	try { obj[name] = value; } catch {}
	if (obj[name] !== value) { try { Object.defineProperty(obj, name, { value, configurable: true, writable: true }); } catch {} }
};

if (typeof globalThis.setImmediate !== "function" || throws(() => globalThis.clearImmediate(globalThis.setImmediate(() => {})))) {
	replace(globalThis, "setImmediate", (fn, ...args) => {
		const timer = setTimeout(fn, 0, ...args);
		return { timer, ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
	});
	replace(globalThis, "clearImmediate", (handle) => { if (handle) clearTimeout(handle.timer ?? handle); });
}

const proc = globalThis.process;
if (proc && throws(() => proc.nextTick(() => {}))) {
	replace(proc, "nextTick", (fn, ...args) => queueMicrotask(() => fn(...args)));
}
`;
// The isolate's main module: prelude first (ES modules evaluate imports in
// order), then the site's handler and its Durable Object classes.
// The exported handler wraps the site's own: the site gets a small request
// context with the notifications it may use (waitUntil, abort,
// passThroughOnException) but not the runtime's object graph (ctx.exports,
// ctx.props). Today ctx.exports only reaches the site's own module, but a
// future celld release could add more, and this keeps the site's reach fixed.
export const MAIN = `import "./prelude.js";
import * as site from "./worker.js";
import { attach } from "./celld-data.js";
attach(site);
export * from "./worker.js";
export default {
	fetch(request, env, ctx) {
		const safe = {
			waitUntil: (p) => ctx.waitUntil(p),
			passThroughOnException: () => ctx.passThroughOnException(),
		};
		if (typeof ctx.abort === "function") safe.abort = (reason) => ctx.abort(reason);
		return site.default.fetch(request, env, Object.freeze(safe));
	},
};
`;
