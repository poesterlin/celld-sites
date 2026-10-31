// End to end against the appliance image (TLS_MODE=off): one container, nothing
// else. A mock IdP and a real Hamstr Store run in this process; the container
// reaches them on docker0. S3, celld, Hamstr and Caddy are inside it.
//
//   docker build -f appliance/Dockerfile -t celld-appliance . && node appliance/test/e2e.ts
//
// KEEP=1 leaves the container and its volume for a look afterwards.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const IMAGE = process.env.APPLIANCE_IMAGE ?? "celld-appliance";
const { Browser, mockIdp } = await import(`${REPO}/hamstr/test/helpers.ts`);
const { createStore } = await import(`${REPO}/store/server.ts`);

const GW = "172.17.0.1", PORT = 18080, NAME = "appliance-test", VOL = "appliance-test-data";
const HOME = "appliance-home", HOME_VOL = "appliance-home-data", HOME_PORT = 18000;
const SHELL = "hamstr.test", host = (id) => `grain-${id}.grains.test`;
const ORIGIN = { origin: `http://${SHELL}` };
const FORM = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
const dir = mkdtempSync(join(tmpdir(), "appliance-e2e-"));
const sh = (cmd, args, input?) => execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const forward = (from, to, bind = GW) => new Promise<any>((r) => { const s = createServer((c) => { const u = connect(to, "127.0.0.1"); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }); s.listen(from, bind, () => r(s)); });
const ms = (t) => `${Math.round(performance.now() - t)} ms`;
const waitHealthy = async (name = NAME) => { const t = performance.now(); for (;;) { const s = sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", name]).trim(); if (s === "healthy") return ms(t); if (performance.now() - t > 180000) throw new Error(`not healthy: ${s}\n${sh("docker", ["logs", "--tail", "40", name])}`); await new Promise((r) => setTimeout(r, 500)); } };

const idp = await mockIdp();
const idpFwd = await forward(18091, Number(new URL(idp.issuer).port));
const idpLocal = await forward(18091, Number(new URL(idp.issuer).port), "127.0.0.1");
// Hamstr allows plain HTTP issuers only on loopback: same URL on both sides.
idp.issuer = "http://127.0.0.1:18091";
const store = createStore({ dataDir: join(dir, "store"), rateLimit: false, logging: false });
const storePort = (await store.listen(0, "127.0.0.1")).port;
const storeFwd = await forward(18092, storePort);
const storeBase = `http://127.0.0.1:${storePort}`;
const { token } = await (await fetch(`${storeBase}/api/v1/publishers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "e2e", password: "correct horse battery" }) })).json();
writeFileSync(join(dir, "cli.json"), JSON.stringify({ store: storeBase, token, publisher: "e2e" }), { mode: 0o600 });
try {
	const config = join(dir, "cli.json");
	await new Promise<void>((res, rej) => {
		const c = spawn(process.execPath, [`${REPO}/store/cli/hamstr.ts`, "publish", `${REPO}/store/test/fixtures/pinboard`], { env: { ...process.env, HAMSTR_CLI_CONFIG: config, HAMSTR_STORE: storeBase }, stdio: ["ignore", "pipe", "pipe"] });
		let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
		c.on("close", (code) => (code === 0 ? res() : rej(new Error(out))));
	});
	console.log("published pinboard to a local store");

	for (const [name, vol] of [[NAME, VOL], [HOME, HOME_VOL]]) {
		try { sh("docker", ["rm", "-f", name]); } catch {}
		try { sh("docker", ["volume", "rm", vol]); } catch {}
	}
	let t = performance.now();
	sh("docker", ["run", "-d", "--name", NAME, "--init", "-p", `127.0.0.1:${PORT}:8000`, "-v", `${VOL}:/data`,
		"-e", `HAMSTR_HOST=${SHELL}`, "-e", "HAMSTR_GRAIN_DOMAIN=grains.test", "-e", "HAMSTR_SCHEME=http",
		"-e", `HAMSTR_STORE=http://${GW}:18092`, "-e", `HAMSTR_STORE_PUBLIC=http://${GW}:18092`,
		"-e", "OIDC_NAME=Test", "-e", `OIDC_ISSUER=${idp.issuer}`, "-e", `OIDC_CLIENT_ID=${idp.clientId}`, "-e", `OIDC_CLIENT_SECRET=${idp.clientSecret}`,
		IMAGE]);
	console.log(`fresh start to healthy: ${await waitHealthy()}`);
	const idpInside = () => sh("docker", ["exec", "-d", NAME, "node", "-e", `require("net").createServer((c)=>{const u=require("net").connect(18091,"${GW}");c.pipe(u).pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(18091,"127.0.0.1")`]);
	idpInside();
	// Async, so this process can answer the IdP request it relays.
	const execAsync = (args) => new Promise<string>((r) => { const c = spawn("docker", args); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", () => r(o)); });
	for (let i = 0; (await execAsync(["exec", NAME, "curl", "-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18091/jwks"])) !== "200"; i++) assert.ok(i < 20, "IdP not reachable from the container");

	const signIn = async (user) => {
		const b = new Browser(PORT);
		idp.nextUser = user;
		const start = await b.request("GET", "/auth/login/test", { host: SHELL });
		assert.equal(start.status, 302, start.text);
		const back = await fetch(start.headers.location, { redirect: "manual" });
		const cb = new URL(back.headers.get("location"));
		assert.ok([302, 303].includes((await b.request("GET", cb.pathname + cb.search, { host: SHELL })).status));
		return b;
	};
	const api = (b, method, path, json?) => b.request(method, path, { host: SHELL, headers: ORIGIN, ...(json !== undefined && { json }) });
	const go = (b, absolute) => { const u = new URL(absolute); return b.request("GET", u.pathname + u.search, { host: u.hostname }); };

	const ada = await signIn({ sub: "u-ada", email: "ada@example.com", name: "Ada Lovelace" });
	t = performance.now();
	const installed = await api(ada, "POST", "/api/apps", { slug: "pinboard" });
	assert.equal(installed.status, 200, installed.text);
	console.log(`installed pinboard from the store: ${ms(t)}`);
	const board = (await api(ada, "POST", "/api/grains", { slug: "pinboard", title: "Kitchen" })).json.grain;
	assert.equal((await go(ada, (await api(ada, "POST", `/api/grains/${board.id}/open`, { path: "/" })).json.url)).status, 303);
	const who = (await ada.request("GET", "/whoami", { host: host(board.id) })).json;
	assert.equal(who.name, "Ada Lovelace");
	assert.equal((await ada.request("POST", "/pin", { host: host(board.id), headers: FORM, body: "text=Buy+oat+milk&color=leaf" })).status, 303);
	assert.match((await ada.request("GET", "/", { host: host(board.id) })).text, /Buy oat milk/);
	console.log("grain through Caddy → Hamstr → celld: identity and a pin OK");

	// Front door: no admin API, grains never straight to celld.
	const anon = new Browser(PORT);
	assert.equal((await anon.request("GET", "/__admin/overview", { host: "admin.internal" })).status, 404);
	assert.equal((await anon.request("GET", "/", { host: host(board.id) })).status, 401);
	const direct = sh("docker", ["exec", NAME, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", `Host: ${host(board.id)}`, "http://127.0.0.1:47180/"]);
	assert.equal(direct, "404", "celld answers a grain only with the proxy token");
	const eve = await signIn({ sub: "u-eve", email: "eve@example.com", name: "Eve" });
	assert.notEqual((await eve.request("GET", "/", { host: host(board.id) })).status, 200);
	console.log("admin.internal 404 at the front door; grain closed to anonymous, to Eve and to direct celld requests");

	// A plain celld site, deployed the way tools/deploy.sh does it.
	execFileSync("npm", ["run", "build"], { cwd: `${REPO}/sites/example`, stdio: "ignore" });
	const bundle = join(dir, "bundle");
	execFileSync(process.execPath, [`${REPO}/tools/pack.ts`, `${REPO}/sites/example`, bundle], { stdio: "ignore" });
	const tar = execFileSync("tar", ["-C", bundle, "-cf", "-", "."]);
	t = performance.now();
	execFileSync("docker", ["exec", "-i", NAME, "/app/with-env", "/app/push.sh", "example.test", "--watch", "0"], { input: tar, stdio: ["pipe", "ignore", "inherit"] });
	console.log(`deployed sites/example: ${ms(t)}`);
	const page = await anon.request("GET", "/", { host: "example.test" });
	assert.equal(page.status, 200, page.text);
	const views = (await anon.request("GET", "/", { host: "example.test" })).text;

	console.log("memory:", sh("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", NAME]).trim());

	// Restart: graceful stop, everything back from /data.
	t = performance.now();
	sh("docker", ["stop", "-t", "60", NAME]);
	console.log(`docker stop: ${ms(t)}, exit code ${sh("docker", ["inspect", "-f", "{{.State.ExitCode}}", NAME]).trim()}`);
	sh("docker", ["start", NAME]);
	console.log(`restart to healthy: ${await waitHealthy()}`);
	assert.match((await ada.request("GET", "/", { host: host(board.id) })).text, /Buy oat milk/, "pin survives a restart, session too");
	assert.equal((await anon.request("GET", "/", { host: "example.test" })).status, 200, "site survives a restart");
	console.log("after restart: session, grain data and site all still there");

	// Crash: kill Hamstr; the supervisor takes the container down, Docker restarts it.
	sh("docker", ["update", "--restart", "unless-stopped", NAME]);
	sh("docker", ["exec", NAME, "sh", "-c", "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '^node hamstr/server.ts' && kill ${p#/proc/}; done; true"]);
	t = performance.now();
	while (sh("docker", ["inspect", "-f", "{{.RestartCount}}", NAME]).trim() === "0") { assert.ok(performance.now() - t < 90000, "container did not restart"); await new Promise((r) => setTimeout(r, 200)); }
	console.log(`killed Hamstr: container went down and Docker restarted it after ${ms(t)}; healthy again ${await waitHealthy()} later`);
	assert.match((await ada.request("GET", "/", { host: host(board.id) })).text, /Buy oat milk/);

	// Home mode: no sign-in, a port per grain, nothing else configured.
	t = performance.now();
	sh("docker", ["run", "-d", "--name", HOME, "--init", "-p", `127.0.0.1:${HOME_PORT}:8000`, "-p", "127.0.0.1:20000-20002:20000-20002", "-v", `${HOME_VOL}:/data`,
		"-e", "HAMSTR_AUTH=none", "-e", "HAMSTR_GRAIN_PORTS=20000-20002", "-e", `HAMSTR_STORE=http://${GW}:18092`, IMAGE]);
	console.log(`home mode: healthy in ${await waitHealthy(HOME)}`);
	const visitor = new Browser(HOME_PORT);
	const shellHost = `127.0.0.1:${HOME_PORT}`;
	const homeApi = (method, path, json?) => visitor.request(method, path, { host: shellHost, headers: { origin: `http://${shellHost}`, "sec-fetch-site": "same-origin" }, ...(json !== undefined && { json }) });
	assert.equal((await visitor.request("GET", "/", { host: shellHost })).status, 200, "the shell opens without signing in");
	assert.equal((await homeApi("POST", "/api/apps", { slug: "pinboard" })).status, 200);
	const homeBoard = (await homeApi("POST", "/api/grains", { slug: "pinboard", title: "Kitchen" })).json.grain;
	const url = (await homeApi("POST", `/api/grains/${homeBoard.id}/open`, { path: "/" })).json.url;
	assert.equal(url, "http://127.0.0.1:20000/");
	const grain = new Browser(20000);
	const grainHeaders = { ...FORM, origin: "http://127.0.0.1:20000" };
	assert.equal((await grain.request("POST", "/pin", { host: "127.0.0.1:20000", headers: grainHeaders, body: "text=From+home+mode&color=sun" })).status, 303);
	const homeWho = (await grain.request("GET", "/whoami", { host: "127.0.0.1:20000" })).json;
	assert.deepEqual([homeWho.name, homeWho.role], ["Owner", "owner"]);
	sh("docker", ["restart", "-t", "60", HOME]);
	await waitHealthy(HOME);
	assert.match((await new Browser(20000).request("GET", "/", { host: "127.0.0.1:20000" })).text, /From home mode/, "the grain's port and data survive a restart");
	console.log(`home mode: shell without sign-in, pinboard installed, grain on port 20000 as the owner, data kept across a restart (${ms(t)})`);
	console.log("appliance e2e OK");
} finally {
	if (!process.env.KEEP) for (const [name, vol] of [[NAME, VOL], [HOME, HOME_VOL]]) try { sh("docker", ["rm", "-f", name]); sh("docker", ["volume", "rm", vol]); } catch {}
	idpFwd.close(); idpLocal.close(); storeFwd.close();
	await store.close(); await idp.close();
	rmSync(dir, { recursive: true, force: true });
}
