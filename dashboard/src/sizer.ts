// Bucket sizer for the dashboard: the only process with the bucket volume mounted
// (read-only). It answers GET /sizes on the project network with disk usage by area
// and per Durable Object, and nothing else: no Traefik route, no file contents. The
// LAN-facing dashboard has no access to site data itself.
// The walk is synchronous and can take a while on a big bucket, so it runs on a
// timer here and requests get the latest result.
import { readdirSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

const config = {
	port: Number(process.env.PORT ?? 3001),
	bucketDir: process.env.BUCKET_DIR ?? "/bucket/celld",
	intervalMs: Number(process.env.SCAN_SECONDS ?? 60) * 1000,
};

interface Usage { bytes: number; files: number }

/** Disk usage (allocated blocks, like `du`) and file count of a directory tree.
 *  celld's logs are thousands of small files, so this is several times their
 *  apparent size, and it's what fills the disk. Symlinks are not followed. */
function usage(dir: string): Usage {
	let bytes = 0, files = 0;
	const walk = (d: string) => {
		let entries;
		try {
			bytes += lstatSync(d).blocks * 512;
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				bytes += lstatSync(p).blocks * 512;
				files++;
			}
		}
	};
	walk(dir);
	return { bytes, files };
}

const add = (a: Usage, b: Usage): Usage => ({ bytes: a.bytes + b.bytes, files: a.files + b.files });
const ZERO: Usage = { bytes: 0, files: 0 };

/** Bucket usage by area, and per Durable Object (cells/SiteObject:<id>). */
function scanBucket() {
	const perObject = new Map<string, Usage>();
	let siteObjects = ZERO, kv = ZERO, other = ZERO;
	const cellsDir = join(config.bucketDir, "cells");
	for (const name of safeList(cellsDir)) {
		const u = usage(join(cellsDir, name));
		if (name.startsWith("SiteObject:")) {
			perObject.set(name.slice("SiteObject:".length), u);
			siteObjects = add(siteObjects, u);
		} else if (name.startsWith("__KvNamespace:")) kv = add(kv, u);
		else other = add(other, u);
	}
	const deployments = usage(join(config.bucketDir, "deploy"));
	for (const name of safeList(config.bucketDir)) {
		if (name !== "cells" && name !== "deploy") other = add(other, usage(join(config.bucketDir, name)));
	}
	let fs = { bavail: 0, blocks: 0, bsize: 0 };
	try {
		fs = statfsSync(config.bucketDir);
	} catch {
		// free space unknown; the rest of the scan is still useful
	}
	return {
		perObject: Object.fromEntries(perObject),
		total: add(add(add(siteObjects, kv), deployments), other),
		siteObjects,
		kv,
		deployments,
		other,
		volumeFreeBytes: fs.bavail * fs.bsize,
		volumeSizeBytes: fs.blocks * fs.bsize,
	};
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

let latest: (ReturnType<typeof scanBucket> & { at: number; ms: number }) | undefined;
let lastError: string | undefined;
function rescan() {
	const started = Date.now();
	try {
		latest = { ...scanBucket(), at: started, ms: Date.now() - started };
		lastError = undefined;
	} catch (e) {
		lastError = (e as Error).message;
	}
}
rescan();
setInterval(rescan, config.intervalMs);

Bun.serve({
	port: config.port,
	fetch(req) {
		const { pathname } = new URL(req.url);
		if (req.method !== "GET") return new Response("Read-only", { status: 405 });
		if (pathname === "/health") return new Response("ok");
		if (pathname === "/sizes") {
			return latest ? Response.json(latest) : Response.json({ error: lastError ?? "no scan yet" }, { status: 503 });
		}
		return new Response("Not found", { status: 404 });
	},
});
console.log(`sizer listening on :${config.port}`);
