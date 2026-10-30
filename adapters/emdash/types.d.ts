// EmDash's Cloudflare adapter is not a dependency of this repo: the adapter
// directory is copied into a site checkout that has it installed. Declare the
// one symbol objects.ts extends so this repo can typecheck on its own.
declare module "@emdash-cms/cloudflare/db/do-sql" {
	export class EmDashDB {
		constructor(ctx: unknown, env: unknown);
		query(sql: string, params?: unknown[], opts?: Record<string, unknown>): Promise<{ rows: any[]; [key: string]: unknown }>;
		batchQuery(statements: any[], opts?: Record<string, unknown>): Promise<any[]>;
	}
}
