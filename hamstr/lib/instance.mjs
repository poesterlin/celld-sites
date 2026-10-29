// Which core a request belongs to. The HTTP entrypoint (server.mjs) runs every
// request inside an AsyncLocalStorage so several Hamstr instances can share one
// process (the tests do that).
//
// The entrypoint and the SvelteKit build are two module instances, and the
// routes must see the *build's* core so the error classes they import are the
// ones the core throws. So this state lives on globalThis and whichever copy
// loads last (the build) registers its core factory.
import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("hamstr.core");

export const state = (globalThis[KEY] ??= { storage: new AsyncLocalStorage(), create: null, fallback: null });

export function runWithCore(core, fn) {
	return state.storage.run(core, fn);
}

export function registerCoreFactory(factory) {
	state.create = factory;
}

export function createInstanceCore(options) {
	if (!state.create) throw new Error("hamstr: no core factory registered; load the built handler first");
	return state.create(options);
}
