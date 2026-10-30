// The build's side of the shared request state (see lib/instance.ts): register
// this copy's core factory and expose the current request's core to routes.
import { createInstanceCore, registerCoreFactory, state } from "../../../lib/instance.ts";
import { createCore } from "./core.ts";

registerCoreFactory(createCore);

export { createInstanceCore, runWithCore } from "../../../lib/instance.ts";

export function core() {
	const found = state.storage.getStore();
	if (found) return found;
	return (state.fallback ??= createInstanceCore());
}
