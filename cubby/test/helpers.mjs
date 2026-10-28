// Shared fixtures for Cubby tests: build real tar.gz bundles and call the API.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function tgz(entries) {
	const packer = pack();
	const chunks = [];
	packer.on("data", (chunk) => chunks.push(chunk));
	for (const item of entries) {
		const data = item.data === undefined ? undefined : Buffer.from(item.data);
		packer.entry(
			{
				name: item.name,
				type: item.type ?? "file",
				...(item.linkname ? { linkname: item.linkname } : {}),
				...(item.pax ? { pax: item.pax } : {}),
				...(data ? { size: data.length } : {}),
				mode: 0o644,
				mtime: new Date(0),
			},
			data,
		);
	}
	packer.finalize();
	await once(packer, "end");
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function codeRecord({ files = {}, source = 'export default { fetch() { return new Response("hi"); } }', extra = {} } = {}) {
	return {
		compatibilityDate: "2026-10-01",
		source,
		files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, [sha256(text), "text/html; charset=utf-8"]])),
		immutable: [],
		mutable: [],
		notFound: "none",
		check: "/",
		...extra,
	};
}

export async function bundle({ version = "aaaaaaaaaaaa", files = { "index.html": "<h1>hi</h1>" }, source } = {}) {
	const record = codeRecord({ files, source });
	const entries = [
		{ name: "version", data: `${version}\n` },
		{ name: "code.json", data: JSON.stringify(record) },
		...Object.entries(files).map(([, text]) => ({ name: `blobs/${sha256(text)}`, data: text })),
	];
	return tgz(entries);
}

export function manifest(over = {}) {
	return {
		schema: 1,
		slug: "hello",
		name: "Hello",
		summary: "A tiny test app.",
		description: "Does one thing.",
		version: "1.0.0",
		license: "MIT",
		icon: "▫",
		tags: ["test"],
		egress: [],
		...over,
	};
}

export async function call(base, path, { method = "GET", json, body, token, headers = {} } = {}) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			accept: "application/json",
			...(json !== undefined ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: json !== undefined ? JSON.stringify(json) : body,
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {}
	return { status: res.status, headers: res.headers, body: parsed, text };
}
