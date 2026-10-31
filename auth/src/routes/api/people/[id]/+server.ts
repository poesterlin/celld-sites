import { actor, api, body } from "#lib/server/http.ts";

export const PATCH = api({ admin: true }, async (event, user) => {
	const patch = await body(event);
	// Only owners hand out or take away ownership.
	const target = event.locals.core.userById(event.params.id);
	if (user.role !== "owner" && (patch.role === "owner" || target?.role === "owner")) return Response.json({ error: "only an owner can change an owner" }, { status: 403 });
	return event.locals.core.updatePerson(actor(user), event.params.id, { name: patch.name, email: patch.email, role: patch.role, status: patch.status });
});
export const DELETE = api({ admin: true }, ({ locals, params }, user) => {
	if (user.role !== "owner" && locals.core.userById(params.id)?.role === "owner") return Response.json({ error: "only an owner can remove an owner" }, { status: 403 });
	locals.core.deletePerson(actor(user), params.id);
});
