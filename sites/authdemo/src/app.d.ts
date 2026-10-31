import type { User } from '#lib/user.ts';

declare global {
	namespace App {
		interface Locals {
			/** Set by hooks.server.ts from the headers the router adds after sign-in. */
			user: User | null;
		}
	}
}

export {};
