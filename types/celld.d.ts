// Ambient types for the runtime a celld site runs in (a workerd isolate) and
// for the two celld extensions this repo relies on: `ctx.props` (the version
// and site an entrypoint was started for) and `ctx.exports`.
//
// This is deliberately the *small* API, like sites/*/src/cloudflare.d.ts: it
// exists for typechecking this repo, not to describe all of workerd. Install
// @cloudflare/workers-types instead if a project needs the full surface.
declare module "cloudflare:workers" {
	interface SqlCursor<T = Record<string, unknown>> {
		one(): T;
		toArray(): T[];
		[Symbol.iterator](): IterableIterator<T>;
		rowsWritten?: number;
	}

	interface SqlStorage {
		exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
	}

	interface DurableObjectStorage {
		sql: SqlStorage;
		get<T = unknown>(key: string): Promise<T | undefined>;
		put<T = unknown>(key: string, value: T): Promise<void>;
		put(entries: Record<string, unknown>): Promise<void>;
		delete(key: string): Promise<boolean>;
		deleteAll(): Promise<void>;
		transactionSync<T>(fn: () => T): T;
		list<T = unknown>(options?: { prefix?: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
	}

	interface DurableObjectId {
		toString(): string;
		name?: string;
	}

	export interface KVNamespaceListKey {
		name: string;
		expiration?: number;
		metadata?: any;
	}

	export interface KVNamespace {
		get<T = any>(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<T | null>;
		getWithMetadata<T = any>(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<{ value: T | null; metadata: any }>;
		put<T = unknown>(key: string, value: T, options?: Record<string, any>): Promise<void>;
		delete(key: string): Promise<void>;
		list<T = unknown>(options?: { limit?: number; prefix?: string; cursor?: string; startAfter?: string }): Promise<{
			keys: KVNamespaceListKey[];
			list_complete: boolean;
			cursor?: string;
		}>;
	}

	/** The bindings celld's router and sites are given; the router extends this. */
	export interface CelldObjectNamespace {
		idFromName(name: string): DurableObjectId;
		get(id: DurableObjectId): any;
		getByName(name: string): any;
	}

	export interface CelldWorkerLoader {
		get(name: string, load: () => any): Promise<any>;
	}

	interface DurableObjectState {
		id: DurableObjectId;
		storage: DurableObjectStorage;
		facets: {
			abort(name: string, reason: Error): void;
			get(name: string, init: () => any): any;
			delete(name: string): void;
		};
		waitUntil(promise: Promise<unknown>): void;
		blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
	}

	interface ExecutionContext {
		waitUntil(promise: Promise<unknown>): void;
		passThroughOnException(): void;
	}

	export class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState & { props: Record<string, any>; exports: Record<string, any> };
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}

	export class WorkerEntrypoint<Env = unknown> {
		protected ctx: ExecutionContext & { props: Record<string, any>; exports: Record<string, any> };
		protected env: Env;
		constructor(ctx: ExecutionContext, env: Env);
	}

	/** The site's own bindings (celld provides OBJECTS and ASSETS). */
	export const env: {
		OBJECTS: {
			call(className: string, name: string, method: string, ...args: unknown[]): Promise<unknown>;
			getByName?(name: string): unknown;
		};
		ASSETS: { fetch(request: Request | string): Promise<Response> };
		[key: string]: any;
	};
}
