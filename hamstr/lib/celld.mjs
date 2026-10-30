// The celld admin API, as Hamstr uses it. One grain is one celld site, so its
// Durable Objects (its data) and its egress grant belong to that grain alone.
// Installing an app uploads its code once; a new grain only stages and
// activates a version the node already has, which takes milliseconds.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { readBundle } from "../../packages/app-format/bundle.mjs";

export class CelldError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function createCelld({ api, adminHost, adminToken, tmpDir, timeoutMs = 120_000 }) {
	const base = new URL(api);

	function call(method, path, body, contentType = "application/json") {
		return new Promise((resolvePromise, rejectPromise) => {
			const headers = { Host: adminHost, authorization: `Bearer ${adminToken}` };
			if (body !== undefined) {
				headers["content-type"] = contentType;
				headers["content-length"] = Buffer.byteLength(body);
			}
			const req = httpRequest({ hostname: base.hostname, port: base.port || 80, path: `/__admin${path}`, method, headers, timeout: timeoutMs }, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json = null;
					try {
						json = JSON.parse(text);
					} catch {}
					resolvePromise({ status: res.statusCode ?? 0, text, json });
				});
			});
			req.on("timeout", () => req.destroy(new Error("the celld node timed out")));
			req.on("error", (err) => rejectPromise(new CelldError(502, `the celld node is unreachable (${err.code ?? err.message})`)));
			if (body !== undefined) req.write(body);
			req.end();
		});
	}
	async function ok(method, path, body, contentType) {
		const r = await call(method, path, body, contentType);
		if (r.status >= 300) throw new CelldError(502, `${method} ${path.split("?")[0]} failed (${r.status}): ${(r.json?.error ?? r.text).slice(0, 300)}`);
		return r.json ?? {};
	}
	const q = (params) => new URLSearchParams(params).toString();

	async function setEgress(host, allow) {
		if (allow.length) await ok("PUT", `/egress?${q({ host })}`, JSON.stringify(allow));
		else await call("DELETE", `/egress?${q({ host })}`);
	}

	/** Remove a site and everything it stored. A site that never went live has
	 *  nothing to delete but may hold an egress grant. */
	async function deleteSite(host) {
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
	async function upload(bundleFile, { egress = [], probeHost }) {
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
	async function deployGrain(host, version, egress = []) {
		await ok("POST", `/stage?${q({ host, version })}`);
		await setEgress(host, egress);
		await ok("POST", `/activate?${q({ host, version })}`);
	}

	return { call, upload, deployGrain, deleteSite, setEgress };
}

/** Download a release bundle from the store into `dir` and check its hash. */
export async function downloadBundle(store, slug, version, expectedSha, dir) {
	// Without a published hash there is nothing to check the download against.
	if (!expectedSha) throw new CelldError(502, "the store published no SHA-256 for this release");
	const res = await fetch(`${store}/api/v1/apps/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}/download`, {
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new CelldError(502, `the store refused the download (${res.status})`);
	const bytes = Buffer.from(await res.arrayBuffer());
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== expectedSha) throw new CelldError(502, "the downloaded bundle does not match the catalog's SHA-256");
	const file = join(dir, `${slug}-${randomBytes(6).toString("hex")}.tgz`);
	writeFileSync(file, bytes, { mode: 0o600 });
	return { file, sha };
}
