// Test harness: runs the production router under `celld dev` on a local port,
// with separate admin and read tokens, and deploys fixture sites through the
// real tools (pack.mjs + node/push.sh). Never touches the production node.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

export const project = resolve(new URL("..", import.meta.url).pathname);
export const ADMIN_HOST = "admin.internal";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
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

	async start() {
		const router = join(this.dir, "router");
		cpSync(join(project, "router"), router, { recursive: true });
		const template = readFileSync(join(router, "wrangler.template.json"), "utf8")
			.replace("@ADMIN_TOKEN_SHA256@", sha256(this.adminToken))
			.replace("@READ_TOKEN_SHA256@", sha256(this.readToken))
			.replace("@ADMIN_HOST@", ADMIN_HOST)
			.replace("@DEFAULT_SITE@", "")
			.replace("@OPERATOR_URL@", "");
		writeFileSync(join(router, "wrangler.json"), template);
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
		if (this.proc?.pid) {
			try {
				process.kill(-this.proc.pid, "SIGTERM");
			} catch {}
			for (let i = 0; i < 60 && this.proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 500));
			try {
				process.kill(-this.proc.pid, "SIGKILL");
			} catch {}
		}
		rmSync(this.dir, { recursive: true, force: true });
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

	/** Pack a site directory and deploy it with the real push.sh; returns the activation result. */
	deploy(siteDir, host, ...pushArgs) {
		const bundle = mkdtempSync(join(tmpdir(), "celld-api-bundle-"));
		try {
			execFileSync("node", [join(project, "tools/pack.mjs"), siteDir, bundle], { env: this.env, stdio: ["ignore", "ignore", "pipe"] });
			const tar = execFileSync("tar", ["-C", bundle, "-cf", "-", "."]);
			const out = execFileSync("sh", [join(project, "node/push.sh"), host, ...pushArgs], {
				input: tar,
				env: { ...this.env, ADMIN_TOKEN: this.adminToken, ADMIN_HOST, CELLD_ADMIN_API: `http://127.0.0.1:${this.port}` },
			});
			return JSON.parse(out.toString());
		} finally {
			rmSync(bundle, { recursive: true, force: true });
		}
	}

	/** Upload a packed bundle's files and code without activating it; returns the version. */
	async stage(bundle, host) {
		const version = readFileSync(join(bundle, "version"), "utf8").trim();
		const lines = readFileSync(join(bundle, "files.tsv"), "utf8").split("\n").filter(Boolean);
		for (const line of lines) {
			const [n, type, path] = line.split("\t");
			const r = await this.admin("PUT", `/asset?version=${version}&path=${path}`, {
				body: readFileSync(join(bundle, "files", n)),
				headers: { "content-type": type },
			});
			if (r.status !== 200) throw new Error(`stage ${path}: ${r.status} ${r.text}`);
		}
		const q = host ? `&host=${host}` : "";
		const r = await this.admin("PUT", `/code?version=${version}${q}`, {
			body: readFileSync(join(bundle, "code.json")),
			headers: { "content-type": "application/json" },
		});
		if (r.status !== 200) throw new Error(`stage code: ${r.status} ${r.text}`);
		return version;
	}

	/** Pack only (for upload tests that drive the API directly). */
	pack(siteDir) {
		const bundle = mkdtempSync(join(tmpdir(), "celld-api-bundle-"));
		execFileSync("node", [join(project, "tools/pack.mjs"), siteDir, bundle], { env: this.env, stdio: ["ignore", "ignore", "pipe"] });
		return bundle;
	}
}
