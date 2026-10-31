import { actor, api, body } from "#lib/server/http.ts";

export const PATCH = api({ admin: true }, async (event, user) => {
	const patch = await body(event);
	const c = event.locals.core;
	// Credentials change through the same save path as creating one.
	if (patch.clientId !== undefined || patch.clientSecret !== undefined || patch.issuer !== undefined || patch.name !== undefined) {
		const current = c.providersList().find((p) => p.id === event.params.id);
		if (!current) return Response.json({ error: "no such provider" }, { status: 404 });
		c.saveProvider(actor(user), { ...patch, id: event.params.id, kind: current.kind, name: patch.name ?? current.name });
	}
	if (patch.enabled !== undefined || patch.autoApprove !== undefined) c.setProvider(actor(user), event.params.id, { enabled: patch.enabled, autoApprove: patch.autoApprove });
});
export const DELETE = api({ admin: true }, ({ locals, params }, user) => void locals.core.deleteProvider(actor(user), params.id));
