// Test harness: runs the production router under `celld dev` on a local port,
// with separate admin and read tokens, and deploys fixture sites through the
// real tools (pack.mjs + node/push.sh). Never touches the production node.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

export const project = resolve(new URL("..", import.meta.url).pathname);
export const ADMIN_HOST = "admin.internal";
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(24).toString("base64url");

export class Node {
	constructor(port = Number(process.env.TEST_PORT ?? 8799)) {
		this.port = port;
		this.adminToken = token();
		this.readToken = token();
		this.dir = mkdtempSync(join(tmpdir(), "celld-api-test-"));
		this.env = {
			...process.env,
			PATH: `${project}/tools/node_modules/.bin:${homedir()}/.local/bin:${process.env.PATH}`,
		};
	}

	/** routerSource: router code to run instead of router/index.js (e.g. an older
	 *  release, to test upgrades). */
	async start({ routerSource } = {}) {
		const router = join(this.dir, "router");
		cpSync(join(project, "router"), router, { recursive: true });
		if (routerSource !== undefined) writeFileSync(join(router, "index.js"), routerSource);
		const template = readFileSync(join(router, "wrangler.template.json"), "utf8")
			.replace("@ADMIN_TOKEN_SHA256@", sha256(this.adminToken))
			.replace("@READ_TOKEN_SHA256@", sha256(this.readToken))
			.replace("@ADMIN_HOST@", ADMIN_HOST)
			.replace("@DEFAULT_SITE@", "")
			.replace("@OPERATOR_URL@", "")
			.replace("@SITE_TIMEOUT_SECS@", "3")
			.replace("@SITE_MAX_INFLIGHT@", process.env.TEST_SITE_MAX_INFLIGHT ?? "128")
			.replace("@SITE_MAX_OBJECTS@", process.env.TEST_SITE_MAX_OBJECTS ?? "1000")
			.replace("@SITE_MAX_SUBREQUESTS@", process.env.TEST_SITE_MAX_SUBREQUESTS ?? "1000");
		writeFileSync(join(router, "wrangler.json"), template);
		return this.#launch();
	}

	/** Restart the node on the same data with other router code (default: router/index.js). */
	async restart(routerSource) {
		await this.#kill();
		const router = join(this.dir, "router");
		writeFileSync(join(router, "index.js"), routerSource ?? readFileSync(join(project, "router/index.js")));
		return this.#launch();
	}

	async #launch() {
		const router = join(this.dir, "router");
		// Own process group, so stop() can end celld dev and its node process together.
		this.proc = spawn("celld", ["dev", "--port", String(this.port), "--no-watch", "--logs"], {
			cwd: router,
			env: this.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.log = "";
		this.proc.stdout.on("data", (d) => (this.log += d));
		this.proc.stderr.on("data", (d) => (this.log += d));
		for (let i = 0; i < 120; i++) {
			try {
				const r = await this.request("GET", "/.well-known/celld/health", { host: "localhost" });
				if (r.status === 200) return this;
			} catch {}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`celld dev did not start:\n${this.log.slice(-2000)}`);
	}

	async stop() {
		await this.#kill();
		rmSync(this.dir, { recursive: true, force: true });
	}

	async #kill() {
		if (this.proc?.pid) {
			try {
				process.kill(-this.proc.pid, "SIGTERM");
			} catch {}
			for (let i = 0; i < 60 && this.proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 500));
			try {
				process.kill(-this.proc.pid, "SIGKILL");
			} catch {}
		}
	}

	/** HTTP request with an explicit Host header (fetch() drops it). */
	request(method, path, { host, headers = {}, body, chunked = false } = {}) {
		const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		return new Promise((done, fail) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: this.port,
					method,
					path,
					headers: { host, ...(data && !chunked ? { "content-length": data.length } : {}), ...headers },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						done({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
					});
				},
			);
			// A server that rejects a body early (413) closes the connection while we
			// are still sending; the response still arrives, so wait for it.
			req.on("error", (e) => {
				if (e.code === "EPIPE" || e.code === "ECONNRESET") setTimeout(() => fail(e), 10_000).unref();
				else fail(e);
			});
			if (data) req.write(data);
			req.end();
		});
	}

	/** Admin API call: token is "admin", "read" or a literal string. */
	admin(method, path, { token = "admin", body, headers = {}, chunked } = {}) {
		const value = token === "admin" ? this.adminToken : token === "read" ? this.readToken : token;
		return this.request(method, `/__admin${path}`, {
			host: ADMIN_HOST,
			headers: { ...(value ? { authorization: `Bearer ${value}` } : {}), ...headers },
			body,
			chunked,
		});
	}

	/** Admin upload of a large body with curl, which (unlike node:http) reliably
	 *  reads a response the server sends before the whole body is uploaded. */
	adminUpload(method, path, bytes) {
		const file = join(this.dir, `upload-${Date.now()}.bin`);
		writeFileSync(file, Buffer.alloc(bytes));
		try {
			const code = execFileSync("curl", [
				"-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", method,
				"-H", `Host: ${ADMIN_HOST}`, "-H", `Authorization: Bearer ${this.adminToken}`,
				"--data-binary", `@${file}`, `http://127.0.0.1:${this.port}/__admin${path}`,
			]);
			return Number(code.toString());
		} finally {
			rmSync(file, { force: true });
		}
	}

	/** Pack a site directory and deploy it with the real push.sh; returns the activation
	 *  result. Without a --watch argument the post-activation watch is off (it takes seconds). */
	deploy(siteDir, host, ...pushArgs) {
		const bundle = mkdtempSync(join(tmpdir(), "celld-api-bundle-"));
		try {
			execFileSync("node", [join(project, "tools/pack.mjs"), siteDir, bundle], { env: this.env, stdio: ["ignore", "ignore", "pipe"] });
			const tar = execFileSync("tar", ["-C", bundle, "-cf", "-", "."]);
			const r = this.push(tar, host, pushArgs);
			if (r.status !== 0) throw new Error(`push.sh failed (${r.status}): ${r.stderr}`);
			return JSON.parse(r.stdout);
		} finally {
			rmSync(bundle, { recursive: true, force: true });
		}
	}

	/** Run the real push.sh with a tar'ed bundle; returns { status, stdout, stderr }. */
	push(tar, host, pushArgs = []) {
		const args = pushArgs.includes("--watch") ? pushArgs : [...pushArgs, "--watch", "0"];
		const r = spawnSync("sh", [join(project, "node/push.sh"), host, ...args], {
			input: tar,
			env: { ...this.env, ADMIN_TOKEN: this.adminToken, ADMIN_HOST, CELLD_ADMIN_API: `http://127.0.0.1:${this.port}` },
		});
		return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
	}

	/** Pack and push a site directory without throwing; returns { status, stdout, stderr }. */
	tryDeploy(siteDir, host, ...pushArgs) {
		const bundle = mkdtempSync(join(tmpdir(), "celld-api-bundle-"));
		try {
			execFileSync("node", [join(project, "tools/pack.mjs"), siteDir, bundle], { env: this.env, stdio: ["ignore", "ignore", "pipe"] });
			return this.push(execFileSync("tar", ["-C", bundle, "-cf", "-", "."]), host, pushArgs);
		} finally {
			rmSync(bundle, { recursive: true, force: true });
		}
	}

	/** Upload a packed bundle's files and code without activating it; returns the version. */
	async stage(bundle, host) {
		const version = readFileSync(join(bundle, "version"), "utf8").trim();
		for (const hash of readdirSync(join(bundle, "blobs"))) {
			const r = await this.admin("PUT", `/blob?hash=${hash}`, { body: readFileSync(join(bundle, "blobs", hash)) });
			if (r.status !== 200) throw new Error(`stage ${hash}: ${r.status} ${r.text}`);
		}
		const q = host ? `&host=${host}` : "";
		const r = await this.admin("PUT", `/code?version=${version}${q}`, {
			body: readFileSync(join(bundle, "code.json")),
			headers: { "content-type": "application/json" },
		});
		if (r.status !== 200) throw new Error(`stage code: ${r.status} ${r.text}`);
		return version;
	}

	/** Upload one file as a blob; returns its hash. */
	async putBlob(content) {
		const hash = sha256(content);
		const r = await this.admin("PUT", `/blob?hash=${hash}`, { body: content });
		if (r.status !== 200) throw new Error(`blob: ${r.status} ${r.text}`);
		return hash;
	}

	/** Upload a static-only version by hand: files is { path: text }. */
	async putVersion(version, files, { host } = {}) {
		const map = {};
		for (const [path, content] of Object.entries(files)) map[path] = [await this.putBlob(content), "text/plain; charset=utf-8"];
		const q = host ? `&host=${host}` : "";
		return this.admin("PUT", `/code?version=${version}${q}`, {
			body: { compatibilityDate: "2026-10-01", files: map },
			headers: { "content-type": "application/json" },
		});
	}

	/** Pack only (for upload tests that drive the API directly). */
	pack(siteDir) {
		const bundle = mkdtempSync(join(tmpdir(), "celld-api-bundle-"));
		execFileSync("node", [join(project, "tools/pack.mjs"), siteDir, bundle], { env: this.env, stdio: ["ignore", "ignore", "pipe"] });
		return bundle;
	}
}
