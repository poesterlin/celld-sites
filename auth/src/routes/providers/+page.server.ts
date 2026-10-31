import { admin } from "#lib/server/guard.ts";

export function load({ locals }) {
	return { providers: admin(locals).providersList() };
}
