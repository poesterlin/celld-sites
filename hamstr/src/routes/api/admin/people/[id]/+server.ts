import { accountsApi, body } from "#lib/server/accounts.ts";
import { json } from "#lib/server/http.ts";

// Only an owner hands out or takes away ownership.
const ownerOnly = (event, user, a, patch: { role?: string } = {}) =>
	user.role !== "owner" && (patch.role === "owner" || a.userById(event.params.id)?.role === "owner") ? json(event.locals.core, 403, { error: "only an owner can change an owner" }) : null;

export const PATCH = accountsApi({ admin: true }, async (event, user, a) => {
	const patch = await body(event);
	return ownerOnly(event, user, a, patch) ?? a.updatePerson(user.id, event.params.id, { name: patch.name, email: patch.email, role: patch.role, status: patch.status });
});
export const DELETE = accountsApi({ admin: true }, (event, user, a) => ownerOnly(event, user, a) ?? void a.deletePerson(user.id, event.params.id));
