// Hamstr: a personal app platform in the spirit of Sandstorm, on a celld node.
//
// The UI, the JSON API and the grain proxy are a SvelteKit app (src/). This
// file is the HTTP entrypoint: it gives SvelteKit's Node handler a request per
// connection, one core (SQLite, config, celld client) per instance, and the
// process-level timeouts and logging.
//
// One process answers two kinds of hostname:
//   HAMSTR_HOST            the shell: UI, JSON API, sign-in
//   grain-<id>.<domain>    a grain: /.hamstr/enter, then everything is proxied
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInstanceCore, runWithCore } from "./lib/instance.ts";
import { grainRequest } from "./lib/proxy.ts";

export { siteOf } from "./lib/site.ts";

// adapter-node reads these once, when its handler is imported.
process.env.PROTOCOL_HEADER ??= "x-forwarded-proto";
// Backups are uploaded whole (up to 1 GiB, checked by their routes); every
// JSON route reads at most 64 KB itself (readBody), so this only sets the ceiling.
process.env.BODY_SIZE_LIMIT ??= "1100M";

let loading;
function handler() {
	loading ??= import("./build/handler.js")
		.then((module: any) => module.handler)
		.catch((err) => {
			throw new Error(`hamstr: build/handler.js is missing — run "npm run build" first (${err.message})`);
		});
	return loading;
}

const HEALTH = '{"ok":true}';

/** Answer one grain-host request with the proxy, bridging Node's streams. */
async function serveGrain(core, grainId, req, res) {
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	const url = new URL(`${core.config.scheme}://${req.headers.host}${req.url ?? "/"}`);
	const request = new Request(url, {
		method: req.method,
		headers: req.headers,
		body: hasBody ? (Readable.toWeb(req) as any) : undefined,
		duplex: "half"
	} as any);
	const response = await grainRequest({ request, url, locals: { core } }, grainId);
	const headers = {};
	for (const [key, value] of response.headers) if (key !== "set-cookie") headers[key] = value;
	const cookies = response.headers.getSetCookie();
	if (cookies.length) headers["set-cookie"] = cookies;
	res.writeHead(response.status, headers);
	if (response.body && req.method !== "HEAD") Readable.fromWeb(response.body).pipe(res);
	else {
		await response.body?.cancel();
		res.end();
	}
}

export function createHamstr(options = {}) {
	let core;
	let server;

	// The core is built by the SvelteKit build's own module instance, after the
	// handler has loaded, so routes and their errors share one set of classes.
	const ready = handler().then(() => {
		core = createInstanceCore(options);
	});

	return {
		get config() {
			return core?.config;
		},
		get core() {
			return core;
		},
		get db() {
			return core?.db;
		},
		async listen(port?: number, host?: string): Promise<AddressInfo> {
			await ready;
			port ??= core.config.port;
			host ??= core.config.host;
			const handle = await handler();
			server = createServer((req, res) => {
				const started = Date.now();
				// adapter-node builds request.url from this header; never trust the
				// browser's copy, our scheme comes from config.
				req.headers["x-forwarded-proto"] = core.config.scheme;
				const url = req.url ?? "/";
				const pathname = url.split("?")[0];
				const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");

				// Answer health on any host, as before; a malformed Host must not crash.
				if (pathname === "/api/health") {
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
						"content-length": Buffer.byteLength(HEALTH)
					});
					res.end(req.method === "HEAD" ? undefined : HEALTH);
					return;
				}

				res.on("finish", () => {
					// Paths only: query strings carry tickets.
					if (core.config.logging) console.log(`${req.method} ${host}${pathname} ${res.statusCode} ${Date.now() - started}ms`);
				});

				// Grain hosts are proxied here, before SvelteKit: its CSRF check
				// runs before hooks and would refuse the grains' own form posts.
				// (vite dev skips that check, so hooks handles grains there.)
				const grain = core.grainPattern.exec(host);
				if (grain) {
					runWithCore(core, () => serveGrain(core, grain[1], req, res)).catch((err) => {
						console.error("hamstr: grain request failed", err);
						if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("bad gateway\n");
						else res.destroy();
					});
					return;
				}

				// adapter-node's handler returns nothing for its own static assets
				// and a promise for everything it hands to SvelteKit, so always
				// await it inside the context.
				runWithCore(core, async () => {
					await handle(req, res);
				}).catch((err) => {
					console.error("hamstr: request failed", err);
					if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("internal error\n");
					else res.destroy();
				});
			});
			server.headersTimeout = 15_000;
			server.requestTimeout = 300_000; // installs download and check a bundle
			server.on("clientError", (_err, socket) => {
				if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			});
			await new Promise<void>((resolvePromise, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolvePromise();
				});
			});
			return server.address() as AddressInfo;
		},
		async close() {
			server?.closeAllConnections?.();
			if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
			await ready.catch(() => {});
			core?.close();
		}
	};
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const app = createHamstr();
	const address = await app.listen();
	const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
	console.log(`hamstr: http://${where} (shell ${app.config.shellHost}, grains ${app.config.grainPrefix}*.${app.config.grainDomain})`);
	const stop = async (signal) => {
		console.log(`hamstr: ${signal}, shutting down`);
		await app.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("unhandledRejection", (reason) => console.error("hamstr: unhandled rejection", reason));
}
