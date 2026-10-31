import { accountsApi, body } from "#lib/server/accounts.ts";
import { json } from "#lib/server/http.ts";

const CREDENTIALS = ["clientId", "clientSecret", "issuer", "name"];

export const PATCH = accountsApi({ admin: true }, async (event, user, a) => {
	const patch = await body(event);
	const current = a.providersList().find((p) => p.id === event.params.id);
	if (!current) return json(event.locals.core, 404, { error: "no such provider" });
	// Credentials go through the same checks as creating one.
	if (CREDENTIALS.some((k) => patch[k] !== undefined)) a.saveProvider(user.id, { ...patch, id: current.id, kind: current.kind, name: patch.name ?? current.name });
	if (patch.enabled !== undefined || patch.autoApprove !== undefined) a.setProvider(user.id, current.id, { enabled: patch.enabled, autoApprove: patch.autoApprove });
});
export const DELETE = accountsApi({ admin: true }, (event, user, a) => void a.deleteProvider(user.id, event.params.id));
