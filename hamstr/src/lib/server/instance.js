// The build's side of the shared request state (see lib/instance.mjs): register
// this copy's core factory and expose the current request's core to routes.
import { createInstanceCore, registerCoreFactory, state } from "../../../lib/instance.mjs";
import { createCore } from "./core.js";

registerCoreFactory(createCore);

export { createInstanceCore, runWithCore } from "../../../lib/instance.mjs";

export function core() {
	const found = state.storage.getStore();
	if (found) return found;
	return (state.fallback ??= createInstanceCore());
}
