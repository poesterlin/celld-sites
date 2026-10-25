// Fixture worker: each route exercises one part of the site API.
import { env } from "cloudflare:workers";

const json = (body, status = 200) => Response.json(body, { status });
const attempt = async (fn) => {
	try {
		return json({ ok: true, result: await fn() });
	} catch (e) {
		return json({ ok: false, error: String(e?.message ?? e) });
	}
};

export default {
	async fetch(req) {
		const url = new URL(req.url);
		const q = url.searchParams;
		switch (url.pathname) {
			case "/echo":
				return json({ url: req.url, method: req.method, host: req.headers.get("host") });
			case "/obj":
				return attempt(() => env.OBJECTS.call(q.get("class"), q.get("name"), q.get("method"), ...JSON.parse(q.get("args") ?? "[]")));
			case "/clone":
				return attempt(() => env.OBJECTS.call("Kv", "x", "echo", new Request("http://example.com/")));
			case "/egress":
				return attempt(() => fetch("https://example.com/").then((r) => r.status));
			case "/spin":
				for (;;) {}
			case "/assets-binding":
				return attempt(async () => {
					const r = await env.ASSETS.fetch(new Request(new URL("/hello.txt", req.url)));
					return { status: r.status, text: await r.text() };
				});
			case "/assets-binding-missing":
				return attempt(async () => (await env.ASSETS.fetch(new Request(new URL("/nope.txt", req.url)))).status);
			default:
				return new Response("worker fallback", { status: 404 });
		}
	},
};
