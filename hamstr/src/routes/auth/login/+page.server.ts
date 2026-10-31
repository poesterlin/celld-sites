import { redirect } from "@sveltejs/kit";
import { safePath } from "#lib/server/core.ts";

export function load({ url, locals }) {
	const req = url.searchParams.get("req");
	const next = safePath(url.searchParams.get("next") ?? "/");
	if (locals.user) redirect(303, req ? `/auth/authorize?req=${encodeURIComponent(req)}` : next);
	const accounts = locals.core.accounts;
	return {
		name: locals.core.NAME,
		options: accounts.loginOptions(),
		req,
		next,
		error: url.searchParams.get("error"),
		first: accounts.people().length === 0,
	};
}
