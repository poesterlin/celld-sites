// Bucket disk usage by area and per Durable Object, read straight from the
// bucket volume (mounted read-only). The walk is synchronous and slow on a big
// bucket, so it runs in a worker (bucket-worker.ts), never in the server thread.
import { readdirSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

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
export function scanBucket(bucketDir: string) {
	const perObject = new Map<string, Usage>();
	let siteObjects = ZERO, kv = ZERO, other = ZERO;
	const cellsDir = join(bucketDir, "cells");
	for (const name of safeList(cellsDir)) {
		const u = usage(join(cellsDir, name));
		if (name.startsWith("SiteObject:")) {
			perObject.set(name.slice("SiteObject:".length), u);
			siteObjects = add(siteObjects, u);
		} else if (name.startsWith("__KvNamespace:")) kv = add(kv, u);
		else other = add(other, u);
	}
	const deployments = usage(join(bucketDir, "deploy"));
	for (const name of safeList(bucketDir)) {
		if (name !== "cells" && name !== "deploy") other = add(other, usage(join(bucketDir, name)));
	}
	let fs = { bavail: 0, blocks: 0, bsize: 0 };
	try {
		fs = statfsSync(bucketDir);
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
