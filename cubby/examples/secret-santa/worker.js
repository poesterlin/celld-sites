const esc = (value) =>
	String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const page = (body, status = 200) =>
	new Response(
		`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secret Santa</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf7;--panel:#fff;--ink:#1d1c19;--dim:#6b675f;--line:#e6e1d8;--accent:#b4532a}
@media(prefers-color-scheme:dark){:root{--bg:#151412;--panel:#1d1b18;--ink:#f1ede5;--dim:#a49d90;--line:#2e2a25;--accent:#e58a5f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 20px}
h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 6px}.dim{color:var(--dim)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1 1 200px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--ink);font:inherit}
button{border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:9px;padding:10px 16px;font:inherit;cursor:pointer}
button.ghost{background:transparent;color:var(--accent)}
li{margin:6px 0}.pairs{list-style:none;padding:0}.pairs li{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:10px 0}
.error{color:#b3261e}
</style></head><body><main>${body}</main></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);

const redirect = (to) => new Response(null, { status: 303, headers: { location: to } });

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

		// Hamstr's "Download data" (cubby.json "export"). The pairs are the secret,
		// so only the owner gets them.
		if (url.pathname === "/export") {
			if (request.headers.get("x-hamstr-role") !== "owner") return new Response("owner only\n", { status: 403 });
			const [people, pairs] = await Promise.all([env.OBJECTS.call("Draw", "main", "list"), env.OBJECTS.call("Draw", "main", "pairs")]);
			return Response.json(
				{ app: "secret-santa", exportedAt: new Date().toISOString(), people, pairs: pairs.map(([giver, receiver]) => ({ giver, receiver })) },
				{ headers: { "content-disposition": 'attachment; filename="secret-santa.json"' } },
			);
		}

		if (request.method === "POST") {
			let form;
			try {
				form = await request.formData();
			} catch {
				return page('<p class="error">That form could not be read.</p>', 400);
			}
			const name = String(form.get("name") ?? "").trim();
			if (url.pathname === "/add") {
				if (name) await env.OBJECTS.call("Draw", "main", "add", name.slice(0, 40));
				return redirect("/");
			}
			if (url.pathname === "/reset") {
				await env.OBJECTS.call("Draw", "main", "reset");
				return redirect("/");
			}
			if (url.pathname === "/draw") {
				try {
					const pairs = await env.OBJECTS.call("Draw", "main", "draw");
					return page(`<h1>Who buys for whom</h1>
<p class="dim">Screenshot this, then delete the draw if the surprise matters.</p>
<div class="card"><ul class="pairs">${pairs.map(([a, b]) => `<li><span>${esc(a)}</span><span>→ ${esc(b)}</span></li>`).join("")}</ul></div>
<p><a href="/">Back</a></p>`);
				} catch (err) {
					return page(`<h1>Not yet</h1><p class="error">${esc(err?.message ?? err)}</p><p><a href="/">Back</a></p>`, 400);
				}
			}
			return page("<p>Not found.</p>", 404);
		}

		const names = await env.OBJECTS.call("Draw", "main", "list");
		const pairs = await env.OBJECTS.call("Draw", "main", "pairs");
		const list = names.length
			? `<ul>${names.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
			: '<p class="dim">No names yet.</p>';
		const drawn = pairs.length
			? `<div class="card"><strong>Names are drawn.</strong><p class="dim">Open the draw to see the pairs, or reset to start over.</p>
			<form method="post" action="/draw"><button type="submit">Show the pairs</button></form></div>`
			: "";
		return page(`<h1>Secret Santa</h1>
<p class="dim">One tiny app. No account, no cloud, no network.</p>
<div class="card">
	<form method="post" action="/add"><input name="name" maxlength="40" placeholder="Add a name" aria-label="Name" required><button type="submit">Add</button></form>
	${list}
	${names.length ? `<form method="post" action="/draw" style="margin-top:12px"><button type="submit">Draw names</button></form>` : ""}
</div>
${drawn}
${names.length ? `<form method="post" action="/reset"><button class="ghost" type="submit">Reset everything</button></form>` : ""}
<p class="dim" style="margin-top:28px">Data lives in this app's SQLite database on your celld node.</p>`);
	},
};
