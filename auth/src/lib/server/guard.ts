import { error } from "@sveltejs/kit";

export function admin(locals) {
	if (!locals.user || locals.user.role === "member") error(403, "admins only");
	return locals.core;
}
