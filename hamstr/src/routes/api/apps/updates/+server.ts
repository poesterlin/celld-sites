import { guard, json, requireUser } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	requireUser(event);
	const apps = c.db.prepare("SELECT slug, store_id, version FROM apps").all();
	const updates = {};
	await Promise.all(
		apps.map(async (a) => {
			try {
				const detail = await c.storeJson(`/api/v1/apps/${c.storePath(a.store_id ?? a.slug)}`);
				const latest = (detail.releases ?? []).find((r) => r.status === "published");
				if (latest && latest.version !== a.version) updates[a.slug] = { version: latest.version, egress: latest.manifest?.egress ?? [], devices: latest.manifest?.devices ?? [] };
			} catch {}
		}),
	);
	return json(c, 200, { updates });
});
