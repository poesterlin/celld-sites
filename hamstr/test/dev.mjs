// Local playground: a celld dev node, a Cubby store with the example apps, a
// mock IdP that signs you in as Ada (admin), and Hamstr on http://hamstr.localhost:PORT.
// Browsers resolve *.localhost to 127.0.0.1, so grain hosts work too.
//
//   node hamstr/test/dev.mjs          (Ctrl+C to stop; everything is temporary)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Node } from "../../tests/harness.mjs";
import { createStore } from "../../cubby/server.mjs";
import { createHamstr } from "../server.mjs";
import { Browser, mockIdp } from "./helpers.mjs";

const PORT = Number(process.env.HAMSTR_DEV_PORT ?? 8795);
const dir = mkdtempSync(join(tmpdir(), "hamstr-dev-"));
const node = new Node(Number(process.env.HAMSTR_DEV_CELLD_PORT ?? 8796));
const store = createStore({ dataDir: join(dir, "store"), rateLimit: false, logging: false });
const idp = await mockIdp();
idp.nextUser = { sub: "u-ada", email: "ada@example.com", name: "Ada Lovelace", username: "ada" };

const storeBase = `http://127.0.0.1:${(await store.listen(0, "127.0.0.1")).port}`;
const { token } = await (
	await fetch(`${storeBase}/api/v1/publishers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "examples", password: "correct horse battery" }) })
).json();
const config = join(dir, "cubby.json");
writeFileSync(config, JSON.stringify({ store: storeBase, token, publisher: "examples" }), { mode: 0o600 });
for (const app of ["pinboard", "secret-santa"]) {
	await new Promise((ok, fail) =>
		spawn(process.execPath, [join(import.meta.dirname, "../../cubby/cli/cubby.mjs"), "publish", join(import.meta.dirname, "../../cubby/examples", app)], {
			env: { ...process.env, CUBBY_CONFIG: config, CUBBY_STORE: storeBase },
			stdio: "ignore",
		}).on("close", (code) => (code === 0 ? ok() : fail(new Error(`publishing ${app} failed`)))),
	);
}
await node.start();
const hamstr = createHamstr({
	dataDir: join(dir, "hamstr"),
	shellHost: "hamstr.localhost",
	grainDomain: "localhost",
	scheme: "http",
	publicPort: PORT,
	store: storeBase,
	storePublic: storeBase,
	celldApi: `http://127.0.0.1:${node.port}`,
	adminToken: node.adminToken,
	proxyToken: node.proxyToken,
	secret: "dev",
	oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
	admins: ["ada@example.com"],
});
await hamstr.listen(PORT, "127.0.0.1");

// Seed as Ada: install both apps and make a board with a couple of notes.
{
	const shell = "hamstr.localhost";
	const b = new Browser(PORT);
	const start = await b.request("GET", "/auth/login", { host: shell });
	const back = new URL((await fetch(start.headers.location, { redirect: "manual" })).headers.get("location"));
	await b.request("GET", back.pathname + back.search, { host: shell });
	const api = (method, path, json) => b.request(method, path, { host: shell, headers: { origin: `http://${shell}:${PORT}` }, json });
	await api("POST", "/api/apps", { slug: "pinboard" });
	await api("POST", "/api/apps", { slug: "secret-santa" });
	const board = (await api("POST", "/api/grains", { slug: "pinboard", title: "Kitchen board" })).json.grain;
	await api("POST", "/api/grains", { slug: "secret-santa", title: "Wichteln 2026" });
	const enter = new URL((await api("POST", `/api/grains/${board.id}/open`, { path: "/" })).json.url);
	const host = enter.hostname;
	await b.request("GET", enter.pathname + enter.search, { host });
	const form = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" };
	for (const [text, color] of [["Buy oat milk and birthday candles", "leaf"], ["Dentist Thursday 9:30", "sky"], ["Who took the good scissors?", "rose"]]) {
		await b.request("POST", "/pin", { host, headers: form, body: new URLSearchParams({ text, color }).toString() });
	}
}
console.log(`Hamstr dev: http://hamstr.localhost:${PORT}  (you sign in as Ada; store ${storeBase})`);

const stop = async () => {
	await hamstr.close();
	await node.stop();
	await store.close();
	await idp.close();
	rmSync(dir, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
