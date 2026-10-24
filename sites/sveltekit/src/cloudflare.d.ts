// Minimal types for the runtime module this site uses (the router provides the
// bindings; see router/index.js). Enough for svelte-check, not a full API.
declare module 'cloudflare:workers' {
	interface SqlCursor {
		one(): Record<string, unknown>;
		toArray(): Record<string, unknown>[];
	}
	interface DurableObjectState {
		id: unknown;
		storage: { sql: { exec(query: string, ...bindings: unknown[]): SqlCursor } };
	}
	export class DurableObject {
		protected ctx: DurableObjectState;
		protected env: unknown;
		constructor(ctx: DurableObjectState, env: unknown);
	}
	export const env: {
		OBJECTS: { call(className: string, name: string, method: string, ...args: unknown[]): Promise<unknown> };
		ASSETS: { fetch(request: Request | string): Promise<Response> };
	};
}
