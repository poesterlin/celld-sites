// Pinboard: a Hamstr demo. The app has no login code at all. Hamstr's proxy
// authenticates the visitor and tells the app who they are and what they may do:
//
//   X-Hamstr-User-Id      stable id for a signed-in user (absent for guests)
//   X-Hamstr-Username     display name, percent-encoded (UTF-8)
//   X-Hamstr-Permissions  comma-separated permission ids from hamstr.json
//   X-Hamstr-Role         "owner" or the role id of the share link used
//
// Outside Hamstr nobody can send these headers to the app: the router serves
// grain sites only to the proxy, and the proxy drops any the browser sends.
const COLORS = ["sun", "leaf", "sky", "rose", "sand"];

const esc = (value) =>
	String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function visitor(request) {
	let name = "Guest";
	try {
		name = decodeURIComponent(request.headers.get("x-hamstr-username") ?? "") || "Guest";
	} catch {}
	const perms = new Set((request.headers.get("x-hamstr-permissions") ?? "").split(",").filter(Boolean));
	return {
		id: request.headers.get("x-hamstr-user-id") || null,
		name: name.slice(0, 60),
		role: request.headers.get("x-hamstr-role") || "",
		can: (p) => perms.has(p),
	};
}

const page = (body, status = 200) =>
	new Response(
		`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pinboard</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f9;--ink:#18181b;--dim:#6b6b76;--line:rgba(24,24,27,.1);--panel:#fff;--accent:#5452e8;
--sun:#fdf0c4;--leaf:#d7f2df;--sky:#dbe8fd;--rose:#fbdce8;--sand:#ebe9f0}
@media(prefers-color-scheme:dark){:root{--bg:#111116;--ink:#f4f4f6;--dim:#9b9ba8;--line:rgba(255,255,255,.09);--panel:#1a1a20;--accent:#7c7bff;
--sun:#3d3520;--leaf:#1f3a2a;--sky:#1f2d4a;--rose:#41223a;--sand:#2a2a33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 20px 48px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
h1{font-size:1.6rem;font-weight:650;letter-spacing:-.025em;margin:0}.dim{color:var(--dim)}.who{font-size:.9rem}
.compose{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 26px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 14px rgba(0,0,0,.04)}
textarea{flex:1 1 280px;min-height:46px;resize:vertical;border:0;background:transparent;color:var(--ink);font:inherit;padding:8px}
textarea:focus{outline:none}.swatches{display:flex;gap:6px;align-items:center}
.swatches label{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);cursor:pointer}
.swatches input{position:absolute;opacity:0;pointer-events:none}.swatches input:checked+label{border-color:var(--ink)}
button{border:0;background:var(--accent);color:#fff;border-radius:10px;padding:8px 15px;font:inherit;font-weight:560;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.pin{border-radius:14px;border:1px solid var(--line);padding:14px 14px 10px;min-height:120px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.pin p{margin:0 0 10px;white-space:pre-wrap;word-wrap:break-word}.meta{display:flex;justify-content:space-between;align-items:center;font-size:.78rem;color:var(--dim)}
.meta button{background:transparent;color:var(--dim);padding:2px 6px;font-size:.8rem}.meta button:hover{color:var(--ink)}
.sun{background:var(--sun)}.leaf{background:var(--leaf)}.sky{background:var(--sky)}.rose{background:var(--rose)}.sand{background:var(--sand)}
.empty{text-align:center;padding:60px 0}.note{background:var(--panel);border:1px dashed var(--line);border-radius:14px;padding:12px 14px;margin:18px 0}
</style></head><body><main>${body}</main></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);

const redirect = (to) => new Response(null, { status: 303, headers: { location: to } });

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return new Response("ok\n", { headers: { "content-type": "text/plain" } });
		const me = visitor(request);

		// Hamstr's "Download data" (hamstr.json "export"): the whole board as JSON.
		if (url.pathname === "/export") {
			const pins = await env.OBJECTS.call("Board", "board", "list");
			return Response.json(
				{ app: "pinboard", exportedAt: new Date().toISOString(), pins: pins.map(({ text, color, author, at }) => ({ text, color, author, at })) },
				{ headers: { "content-disposition": 'attachment; filename="pinboard.json"' } },
			);
		}

		if (url.pathname === "/whoami") {
			return Response.json({ id: me.id, name: me.name, role: me.role, pin: me.can("pin"), moderate: me.can("moderate") });
		}

		if (request.method === "POST") {
			let form;
			try {
				form = await request.formData();
			} catch {
				return page("<p>That form could not be read.</p>", 400);
			}
			if (url.pathname === "/pin") {
				if (!me.can("pin")) return page("<h1>Read only</h1><p class=dim>You can view this board but not pin to it.</p><p><a href=/>Back</a></p>", 403);
				const text = String(form.get("text") ?? "").trim().slice(0, 500);
				const color = COLORS.includes(form.get("color")) ? form.get("color") : COLORS[0];
				if (text) await env.OBJECTS.call("Board", "board", "add", text, color, me.name, me.id);
				return redirect("/");
			}
			if (url.pathname === "/remove") {
				const id = Number(form.get("id"));
				if (!Number.isSafeInteger(id)) return page("<p>Bad note.</p>", 400);
				if (me.can("moderate")) await env.OBJECTS.call("Board", "board", "remove", id, null);
				else if (me.can("pin") && me.id) await env.OBJECTS.call("Board", "board", "remove", id, me.id);
				else return page("<p>You can't remove notes here.</p>", 403);
				return redirect("/");
			}
			return page("<p>Not found.</p>", 404);
		}
		if (url.pathname !== "/") return page("<p>Not found.</p>", 404);

		const pins = await env.OBJECTS.call("Board", "board", "list");
		const canRemove = (pin) => me.can("moderate") || (me.can("pin") && me.id && pin.authorId === me.id);
		const compose = me.can("pin")
			? `<form class="compose" method="post" action="/pin">
	<textarea name="text" maxlength="500" placeholder="Pin a note…" aria-label="Note" required></textarea>
	<div class="swatches">${COLORS.map((c, i) => `<input type="radio" name="color" id="c-${c}" value="${c}"${i === 0 ? " checked" : ""}><label for="c-${c}" class="${c}" title="${c}"></label>`).join("")}</div>
	<button type="submit">Pin it</button>
</form>`
			: `<p class="note dim">You can read this board. Ask the owner for a link that lets you pin.</p>`;
		const grid = pins.length
			? `<div class="grid">${pins
					.map(
						(p) => `<article class="pin ${esc(p.color)}"><p>${esc(p.text)}</p><div class="meta"><span>${esc(p.author)} · ${esc(p.at.slice(0, 10))}</span>${
							canRemove(p) ? `<form method="post" action="/remove"><input type="hidden" name="id" value="${p.id}"><button type="submit" aria-label="Remove">✕</button></form>` : ""
						}</div></article>`,
					)
					.join("")}</div>`
			: `<p class="empty dim">Nothing pinned yet.</p>`;
		return page(`<header><h1>📌 Pinboard</h1><span class="who dim">${esc(me.name)}${me.role ? ` · ${esc(me.role)}` : ""}</span></header>${compose}${grid}`);
	},
};
