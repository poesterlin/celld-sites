// Shared fixtures for Hamstr Store tests: build real tar.gz bundles and call the API.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface TarEntry {
	name: string;
	data?: string | Buffer;
	type?: string;
	linkname?: string;
	pax?: Record<string, string>;
}

export async function tgz(entries: TarEntry[]): Promise<Buffer> {
	const packer = pack();
	const chunks: Buffer[] = [];
	packer.on("data", (chunk: Buffer) => chunks.push(chunk));
	for (const item of entries) {
		const data = item.data === undefined ? undefined : Buffer.from(item.data);
		// tar-stream's HeaderArgument narrows `type` and the optional sizes; this builds it piecemeal.
		const header: any = {
			name: item.name,
			type: item.type ?? "file",
			...(item.linkname ? { linkname: item.linkname } : {}),
			...(item.pax ? { pax: item.pax } : {}),
			...(data ? { size: data.length } : {}),
			mode: 0o644,
			mtime: new Date(0),
		};
		if (data) packer.entry(header, data);
		else packer.entry(header);
	}
	packer.finalize();
	await once(packer, "end");
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function codeRecord({
	files = {},
	source = 'export default { fetch() { return new Response("hi"); } }',
	extra = {},
}: { files?: Record<string, string>; source?: string; extra?: Record<string, unknown> } = {}) {
	return {
		compatibilityDate: "2026-10-01",
		source,
		files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, [sha256(String(text)), "text/html; charset=utf-8"]])),
		immutable: [],
		mutable: [],
		notFound: "none",
		check: "/",
		...extra,
	};
}

export async function bundle({ version = "aaaaaaaaaaaa", files = { "index.html": "<h1>hi</h1>" }, source }: { version?: string; files?: Record<string, string>; source?: string } = {}): Promise<Buffer> {
	const record = codeRecord({ files, source });
	const entries = [
		{ name: "version", data: `${version}\n` },
		{ name: "code.json", data: JSON.stringify(record) },
		...Object.entries(files).map(([, text]) => ({ name: `blobs/${sha256(String(text))}`, data: String(text) })),
	];
	return tgz(entries);
}

export function manifest(over: Record<string, unknown> = {}) {
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

export interface CallOptions {
	method?: string;
	json?: unknown;
	body?: string | Buffer;
	token?: string;
	headers?: Record<string, string>;
}

export interface CallResult {
	status: number;
	headers: Headers;
	body: any;
	text: string;
}

export async function call(base: string, path: string, { method = "GET", json, body, token, headers = {} }: CallOptions = {}): Promise<CallResult> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			accept: "application/json",
			...(json !== undefined ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: (json !== undefined ? JSON.stringify(json) : body) as any,
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {}
	return { status: res.status, headers: res.headers, body: parsed, text };
}
