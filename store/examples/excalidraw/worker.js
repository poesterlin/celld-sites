// Excalidraw for Hamstr: the client of ozencb/excalidraw-persist (MIT) with its
// Express/SQLite server replaced by this worker and one Durable Object. Hamstr
// signs the visitor in, so there is no login, and no share links.
const ok = (data, status = 200) => Response.json({ success: true, data }, { status });
const fail = (message, status) => Response.json({ success: false, message }, { status });

const call = (env, method, ...args) => env.OBJECTS.call("Workspace", "main", method, ...args);
// An object method answers `null` (no such board) or `{ error, message }`.
const reply = (result, data = result) => {
	if (result === null) return fail("Board not found", 404);
	if (result?.error) return fail(result.message, result.error);
	return ok(data);
};

async function json(request) {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function api(request, env, parts) {
	const method = request.method;
	const [section, id, sub, extra] = parts;
	if (section !== "boards") return fail("Not found", 404);

	if (!id) {
		if (method === "GET") return ok(await call(env, "listBoards", "ACTIVE"));
		if (method === "POST") return ok(await call(env, "createBoard"), 201);
	} else if (id === "trash" && method === "GET" && !sub) {
		return ok(await call(env, "listBoards", "DELETED"));
	} else if (!sub) {
		if (method === "PUT") return reply(await call(env, "renameBoard", id, (await json(request))?.name));
		if (method === "DELETE") return reply(await call(env, "setStatus", id, "DELETED"), { message: "Board moved to trash" });
	} else if (sub === "restore" && method === "POST") {
		return reply(await call(env, "setStatus", id, "ACTIVE"), { message: "Board restored from trash" });
	} else if (sub === "permanent" && method === "DELETE") {
		return reply(await call(env, "deleteBoard", id), { message: "Board deleted" });
	} else if (sub === "elements") {
		const body = await json(request);
		if (method === "GET") return reply(await call(env, "scene", id));
		if (method === "PUT") {
			// The client sends { elements, files }; the original also took a bare array.
			const elements = Array.isArray(body) ? body : body?.elements;
			const files = Array.isArray(body) ? {} : body?.files;
			if (!Array.isArray(elements)) return fail("Invalid scene payload: elements must be an array", 400);
			return reply(await call(env, "replaceScene", id, elements, isObject(files) ? files : {}), { message: "Elements replaced" });
		}
		if (method === "PATCH") {
			if (!isObject(body)) return fail("Invalid delta", 400);
			const upserted = Array.isArray(body.upserted) ? body.upserted : [];
			const deleted = Array.isArray(body.deleted) ? body.deleted.map(String) : [];
			return reply(await call(env, "applyDelta", id, upserted, deleted), { message: "Delta applied" });
		}
	} else if (sub === "files" && method === "POST") {
		const body = await json(request);
		if (extra === "check") {
			if (!Array.isArray(body?.fileIds)) return fail("fileIds must be an array", 400);
			return ok({ missingIds: await call(env, "missingFiles", id, body.fileIds.map(String)) });
		}
		if (!extra) {
			if (!isObject(body?.files)) return fail("files must be an object", 400);
			return reply(await call(env, "addFiles", id, body.files), { message: "Files uploaded" });
		}
	} else if (sub === "library") {
		if (method === "GET") return reply(await call(env, "library", id));
		if (method === "PUT") {
			const body = await json(request);
			if (!Array.isArray(body?.libraryItems)) return fail("Invalid payload: libraryItems must be an array", 400);
			return reply(await call(env, "saveLibrary", id, body.libraryItems), { message: "Library saved" });
		}
	}
	return fail("Not found", 404);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

		// Hamstr's "Download data" (hamstr.json "export"): every board as JSON.
		if (url.pathname === "/export") {
			return Response.json(
				{ app: "excalidraw", exportedAt: new Date().toISOString(), boards: await call(env, "exportAll") },
				{ headers: { "content-disposition": 'attachment; filename="excalidraw.json"' } },
			);
		}

		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			try {
				return await api(request, env, url.pathname.split("/").slice(2).filter(Boolean));
			} catch (error) {
				console.error("excalidraw api:", error);
				return fail("Request failed", 500);
			}
		}

		// Client routes (/board/<id>): the static index.html. `notFound: spa` only
		// covers page navigations, so serve it explicitly for anything else.
		return env.ASSETS.fetch(new URL("/index.html", url));
	},
};
