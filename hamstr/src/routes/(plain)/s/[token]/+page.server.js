import { error, redirect } from "@sveltejs/kit";

export function load({ locals, params, setHeaders }) {
	const c = locals.core;
	setHeaders({ "referrer-policy": "no-referrer" });
	const found = c.shareFromToken(params.token);
	if (!found) throw error(404, "This link doesn't work anymore");

	const { share, grain } = found;
	if (locals.user) {
		if (grain.owner_id !== locals.user.id) {
			c.db.prepare("INSERT OR IGNORE INTO members (share_id, user_id, joined_at) VALUES (?, ?, ?)").run(share.id, locals.user.id, c.now());
		}
		throw redirect(303, `/g/${grain.id}`);
	}

	const app = c.q.app.get(grain.slug);
	const owner = c.q.user.get(grain.owner_id);
	const role = c.combine(c.manifestOf(app), new Set([share.role]));
	const roleTitle = (c.manifestOf(app)?.roles ?? []).find((r) => r.id === role.role)?.title ?? "Full access";
	return {
		name: c.NAME,
		token: params.token,
		title: grain.title,
		icon: app?.icon ?? "",
		appName: app?.name ?? grain.slug,
		ownerName: owner?.name ?? "Someone",
		roleTitle
	};
}
