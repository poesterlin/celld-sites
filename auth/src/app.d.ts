declare global {
	namespace App {
		interface Locals {
			core: import("../lib/core.ts").Core;
			user: Record<string, any> | null;
			session: string | null;
			sessionToken: string | null;
		}
	}
}
export {};
