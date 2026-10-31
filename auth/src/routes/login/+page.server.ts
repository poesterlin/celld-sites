import { redirect } from "@sveltejs/kit";

export function load({ url, locals }) {
	const req = url.searchParams.get("req");
	if (locals.user && req) redirect(302, `/authorize?req=${encodeURIComponent(req)}`);
	if (locals.user) redirect(302, "/");
	return {
		options: locals.core.loginOptions(),
		req,
		error: url.searchParams.get("error"),
		first: locals.core.people().length === 0,
	};
}
