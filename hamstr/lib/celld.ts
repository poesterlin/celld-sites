// The celld admin API, as Hamstr uses it. One grain is one celld site, so its
// Durable Objects (its data) and its egress grant belong to that grain alone.
// Installing an app uploads its code once; a new grain only stages and
// activates a version the node already has, which takes milliseconds.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { readBundle } from "../../packages/app-format/bundle.ts";

export class CelldError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface CelldOptions {
	api: string;
	adminHost: string;
	adminToken: string;
	tmpDir: string;
	timeoutMs?: number;
}

/** What an admin call resolves to, whatever the status. */
export interface CelldResponse {
	status: number;
	text: string;
	json: any;
}

export function createCelld({ api, adminHost, adminToken, tmpDir, timeoutMs = 120_000 }: CelldOptions) {
	const base = new URL(api);

	function call(method: string, path: string, body?: string | Buffer, contentType = "application/json"): Promise<CelldResponse> {
		return new Promise<CelldResponse>((resolvePromise, rejectPromise) => {
			const headers: Record<string, string | number> = { Host: adminHost, authorization: `Bearer ${adminToken}` };
			if (body !== undefined) {
				headers["content-type"] = contentType;
				headers["content-length"] = Buffer.byteLength(body);
			}
			const req = httpRequest({ hostname: base.hostname, port: base.port || 80, path: `/__admin${path}`, method, headers, timeout: timeoutMs }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json: any = null;
					try {
						json = JSON.parse(text);
					} catch {}
					resolvePromise({ status: res.statusCode ?? 0, text, json });
				});
			});
			req.on("timeout", () => req.destroy(new Error("the celld node timed out")));
			req.on("error", (err: NodeJS.ErrnoException) => rejectPromise(new CelldError(502, `the celld node is unreachable (${err.code ?? err.message})`)));
			if (body !== undefined) req.write(body);
			req.end();
		});
	}
	async function ok(method: string, path: string, body?: string | Buffer, contentType?: string): Promise<any> {
		const r = await call(method, path, body, contentType);
		if (r.status >= 300) throw new CelldError(502, `${method} ${path.split("?")[0]} failed (${r.status}): ${(r.json?.error ?? r.text).slice(0, 300)}`);
		return r.json ?? {};
	}
	const q = (params) => new URLSearchParams(params).toString();

	async function setEgress(host: string, allow: string[]): Promise<void> {
		if (allow.length) await ok("PUT", `/egress?${q({ host })}`, JSON.stringify(allow));
		else await call("DELETE", `/egress?${q({ host })}`);
	}

	/** Remove a site and everything it stored. A site that never went live has
	 *  nothing to delete but may hold an egress grant. */
	async function deleteSite(host: string): Promise<{ deleted: boolean }> {
		const r = await call("DELETE", `/site?${q({ id: host, confirm: host })}`);
		if (r.status === 404) {
			await call("DELETE", `/egress?${q({ host })}`);
			return { deleted: false };
		}
		if (r.status >= 300) throw new CelldError(502, `deleting ${host} failed (${r.status}): ${(r.json?.error ?? r.text).slice(0, 300)}`);
		return { deleted: true };
	}

	/**
	 * Upload a verified bundle's code to the node and prove it boots: stage it on
	 * a throwaway probe site (with the app's egress), run the deploy check,
	 * then remove the probe. Returns the bundle's celld version id.
	 */
	async function upload(bundleFile: string, { egress = [], probeHost }: { egress?: string[]; probeHost: string }) {
		const dir = mkdtempSync(join(tmpDir, "bundle-"));
		try {
			const meta = await readBundle(bundleFile, { extractTo: dir });
			const hashes = [...new Set(Object.values(meta.code.files).map((value) => value[0]))];
			const { missing } = await ok("POST", "/blobs/missing", JSON.stringify(hashes));
			if (!Array.isArray(missing)) throw new CelldError(502, "the node did not list missing files");
			for (let i = 0; i < missing.length; i += 6) {
				await Promise.all(missing.slice(i, i + 6).map((hash) => ok("PUT", `/blob?${q({ hash })}`, readFileSync(join(dir, "blobs", hash)), "application/octet-stream")));
			}
			await ok("PUT", `/code?${q({ version: meta.version })}`, readFileSync(join(dir, "code.json")));
			try {
				await ok("POST", `/stage?${q({ host: probeHost, version: meta.version })}`);
				if (egress.length) await setEgress(probeHost, egress);
				const check = await ok("POST", `/check?${q({ host: probeHost, version: meta.version })}`);
				if (!check.ok) throw new CelldError(422, `the app failed its start-up check (${check.status} on ${check.path}): ${String(check.error ?? "").slice(0, 300)}`);
				// Activate the probe so DELETE /site can clear its staging records too.
				await ok("POST", `/activate?${q({ host: probeHost, version: meta.version })}`);
			} finally {
				await deleteSite(probeHost).catch(() => {});
			}
			return { version: meta.version, files: meta.files, bytes: meta.bytes };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	/** Point a grain's site at `version` (new grain or app update). */
	async function deployGrain(host: string, version: string, egress: string[] = []): Promise<void> {
		await ok("POST", `/stage?${q({ host, version })}`);
		await setEgress(host, egress);
		await ok("POST", `/activate?${q({ host, version })}`);
	}

	// Backups move whole databases: allow them far longer than a normal call.
	const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
	const adminHeaders = () => ({ Host: adminHost, authorization: `Bearer ${adminToken}` });

	/** Append a backup of the site's objects (GET /__admin/dump, JSON lines) to
	 *  `file`. Throws unless the dump arrived complete. */
	function dumpTo(host: string, file: string): Promise<void> {
		return new Promise<void>((resolvePromise, rejectPromise) => {
			const fail = (err: any) => rejectPromise(err instanceof CelldError ? err : new CelldError(502, `backing up ${host} failed (${err.code ?? err.message})`));
			const req = httpRequest(
				{ hostname: base.hostname, port: base.port || 80, path: `/__admin/dump?${q({ host })}`, method: "GET", headers: adminHeaders(), timeout: BACKUP_TIMEOUT_MS },
				(res) => {
					if (res.statusCode !== 200) {
						const chunks: Buffer[] = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => fail(new CelldError(502, `backing up ${host} failed (${res.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`)));
						return;
					}
					pipeline(res, createWriteStream(file, { flags: "a", mode: 0o600 }))
						.then(() => {
							const last = lastLine(file);
							if (last?.type === "end") return resolvePromise(last);
							fail(new CelldError(502, `backing up ${host} failed: ${last?.type === "error" ? last.error : "the backup ended early"}`));
						})
						.catch(fail);
				},
			);
			req.on("timeout", () => req.destroy(new Error("timed out")));
			req.on("error", fail);
			req.end();
		});
	}

	/** Replace the site's objects with the backup in `file`, read from byte
	 *  `start` (POST /__admin/restore). Returns { status, json }: on failure
	 *  json.changed says whether the site was already partly rewritten. */
	function restoreFrom(host: string, file: string, start = 0): Promise<CelldResponse> {
		return new Promise<CelldResponse>((resolvePromise, rejectPromise) => {
			const length = statSync(file).size - start;
			const headers = { ...adminHeaders(), "content-type": "application/x-ndjson", "content-length": length };
			const req = httpRequest(
				{ hostname: base.hostname, port: base.port || 80, path: `/__admin/restore?${q({ host, confirm: host })}`, method: "POST", headers, timeout: BACKUP_TIMEOUT_MS },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let json: any = null;
						try {
							json = JSON.parse(text);
						} catch {}
						resolvePromise({ status: res.statusCode ?? 0, text, json: json ?? { error: text.slice(0, 300) } });
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("timed out")));
			req.on("error", (err: NodeJS.ErrnoException) => rejectPromise(new CelldError(502, `restoring ${host} failed (${err.code ?? err.message})`)));
			createReadStream(file, { start }).on("error", (err) => req.destroy(err)).pipe(req);
		});
	}

	return { call, upload, deployGrain, deleteSite, setEgress, dumpTo, restoreFrom };
}

/** The last JSON line of a file, or null. */
function lastLine(file) {
	const size = statSync(file).size;
	const length = Math.min(size, 64 * 1024);
	const buf = Buffer.alloc(length);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buf, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	const text = buf.toString("utf8").trimEnd();
	try {
		return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
	} catch {
		return null;
	}
}

/** Download a release bundle from the store into `dir` and check its hash. */
export async function downloadBundle(store, slug, version, expectedSha, dir) {
	// Without a published hash there is nothing to check the download against.
	if (!expectedSha) throw new CelldError(502, "the store published no SHA-256 for this release");
	const res = await fetch(`${store}/api/v1/apps/${String(slug).split("/").map(encodeURIComponent).join("/")}/releases/${encodeURIComponent(version)}/download`, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new CelldError(502, `the store refused the download (${res.status})`);
	const bytes = Buffer.from(await res.arrayBuffer());
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== expectedSha) throw new CelldError(502, "the downloaded bundle does not match the catalog's SHA-256");
	const file = join(dir, `${String(slug).replace(/\//g, "-")}-${randomBytes(6).toString("hex")}.tgz`);
	writeFileSync(file, bytes, { mode: 0o600 });
	return { file, sha };
}
