// Deploying to a celld-sites node over its admin API, in plain Node: the same
// steps node/push.sh runs inside the celld container, so the CLI needs neither
// a checkout of this repo nor sh and curl when it talks to a node directly.
//   1. upload the files the node does not have yet, then the code;
//   2. check: run the new version on a scratch namespace and request its check
//      path; a 5xx, an error or a timeout stops here;
//   3. activate it;
//   4. watch: probe the live site every 2 s for `watch` seconds and roll back to
//      the previous version on a 5xx.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";

const UPLOADS_AT_ONCE = 6;

/** An admin API client. `api` is the node's base URL, e.g. http://127.0.0.1:8080. */
export function adminClient({ api, token, adminHost = "admin.internal", timeoutMs = 120_000 }) {
	const base = new URL(api);
	if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error(`the node's admin URL must be http(s): ${api}`);
	const request = base.protocol === "https:" ? httpsRequest : httpRequest;

	// fetch() cannot set the Host header, and the router picks the admin API by it.
	function send(method, path, { body, type = "application/json", host = adminHost, auth = true, accept } = {}) {
		return new Promise((resolvePromise, rejectPromise) => {
			const req = request(
				{
					hostname: base.hostname,
					port: base.port || (base.protocol === "https:" ? 443 : 80),
					path: `${base.pathname.replace(/\/+$/, "")}${path}`,
					method,
					servername: base.hostname,
					timeout: timeoutMs,
					headers: {
						Host: host,
						...(auth && { authorization: `Bearer ${token}` }),
						...(accept && { accept }),
						...(body !== undefined && { "content-type": type, "content-length": Buffer.byteLength(body) }),
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
					res.on("error", rejectPromise);
				},
			);
			req.on("timeout", () => req.destroy(new Error(`${method} ${path}: no answer from ${base.origin}`)));
			req.on("error", rejectPromise);
			if (body !== undefined) req.write(body);
			req.end();
		});
	}

	return {
		origin: base.origin,
		/** An admin call; resolves { status, text } whatever the status. */
		admin: (method, path, body, type) => send(method, `/__admin${path}`, { body, type }),
		/** A request to a site, as a visitor would make it. */
		visit: (host, path) => send("GET", path, { host, auth: false, accept: "text/html" }),
	};
}

async function ok(promise, what) {
	const res = await promise;
	if (res.status < 200 || res.status > 299) throw new Error(`${what} failed (${res.status}): ${res.text.trim().slice(0, 300)}`);
	try {
		return JSON.parse(res.text);
	} catch {
		return {};
	}
}

/** The files of a bundle (tar.gz, already validated): version, code.json, blobs. */
export async function readEntries(tgz) {
	const files = new Map();
	const ex = extract();
	const done = new Promise((resolvePromise, rejectPromise) => {
		ex.on("entry", (header, stream, next) => {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => {
				if (header.type === "file") files.set(header.name.replace(/^\.\//, ""), Buffer.concat(chunks));
				next();
			});
			stream.on("error", rejectPromise);
		});
		ex.on("finish", resolvePromise);
		ex.on("error", rejectPromise);
	});
	ex.end(gunzipSync(tgz));
	await done;
	const version = files.get("version")?.toString("utf8").trim();
	const code = files.get("code.json");
	if (!version || !code) throw new Error("the bundle has no version or code.json");
	const blobs = new Map([...files].filter(([name]) => name.startsWith("blobs/")).map(([name, data]) => [name.slice(6), data]));
	return { version, code, blobs };
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Deploy a bundle to `host` through `client` (see adminClient). Resolves the
 * activation result; throws (after rolling back, when it can) on failure.
 */
export async function deploy(client, tgz, host, { watch = 10, check = true, log = (line) => console.error(`deploy: ${line}`) } = {}) {
	const { version, code, blobs } = await readEntries(tgz);
	const q = (params) => new URLSearchParams(params).toString();

	// 1. Files first (stored once by hash, shared by versions), then the code.
	const { missing = [] } = await ok(client.admin("POST", "/blobs/missing", JSON.stringify([...blobs.keys()])), "asking which files the node needs");
	log(`uploading ${missing.length} of ${blobs.size} files`);
	const queue = [...missing];
	await Promise.all(
		Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
			for (let hash = queue.shift(); hash; hash = queue.shift()) {
				const data = blobs.get(hash);
				if (!data) throw new Error(`the node asked for ${hash}, which is not in the bundle`);
				await ok(client.admin("PUT", `/blob?${q({ hash })}`, data, "application/octet-stream"), `uploading ${hash.slice(0, 12)}`);
			}
		}),
	);
	await ok(client.admin("PUT", `/code?${q({ version, host })}`, code), "uploading the code");

	// 2. Check the new version before anyone sees it.
	let path = "/";
	if (check) {
		const res = await client.admin("POST", `/check?${q({ host, version })}`);
		let result = {};
		try {
			result = JSON.parse(res.text);
		} catch {}
		if (result.skipped) {
			log('check skipped (celld.json "check": false)');
			watch = 0;
		} else if (res.status === 200 && result.ok) {
			path = result.path ?? "/";
			log(`check passed: ${path} answered ${result.status} in ${result.ms} ms`);
		} else {
			throw new Error(`check failed, not activated (version ${version} stays uploaded): ${res.text.trim().slice(0, 300)}`);
		}
	} else {
		watch = 0;
	}

	// 3. Activate.
	const activated = await ok(client.admin("POST", `/activate?${q({ host, version })}`), "activating");

	// 4. Watch the live site; roll back on a 5xx.
	const previous = activated.previous && activated.previous !== version ? activated.previous : null;
	if (activated.previous === version) watch = 0;
	for (let waited = 0; waited < watch; waited += 2) {
		await sleep(2000);
		let res;
		try {
			res = await client.visit(host, path);
		} catch (err) {
			res = { status: 0, text: err.message };
		}
		if (res.status >= 100 && res.status < 500) continue;
		log(`live probe of ${path} answered ${res.status || "nothing"}: ${res.text.slice(0, 300)}`);
		if (previous) {
			await ok(client.admin("POST", `/activate?${q({ host, version: previous })}`), "rolling back");
			throw new Error(`the new version failed on live data; rolled back to ${previous} (version ${version} stays uploaded)`);
		}
		throw new Error(`the new version failed on live data and there is no previous version; ${version} stays active`);
	}
	if (watch > 0) log(`live probes of ${path} passed for ${watch} s`);
	return activated;
}
