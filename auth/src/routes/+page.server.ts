import { redirect } from "@sveltejs/kit";

export function load({ locals }) {
	redirect(302, locals.user.role === "member" ? "/account" : "/people");
}
