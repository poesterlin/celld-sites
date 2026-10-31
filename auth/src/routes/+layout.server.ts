import { redirect } from "@sveltejs/kit";

const PUBLIC = ["/login", "/authorize", "/blocked", "/callback", "/invite", "/pending", "/logout", "/passkey", "/api"];

export function load({ url, locals }) {
	const user = locals.user;
	if (!user && !PUBLIC.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) redirect(302, `/login`);
	return {
		me: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
		pending: user && user.role !== "member" ? locals.core.pendingCount() : 0,
	};
}
