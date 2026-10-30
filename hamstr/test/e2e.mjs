// End to end against a throwaway local celld dev node (the repo's router under
// `celld dev`), a real Hamstr Store, the real `hamstr publish`, and a mock IdP.
//
//   node hamstr/test/e2e.mjs      (needs celld on PATH and tools' npm deps)
//
// Installs test/fixtures/pinboard, makes two grains, pins through the proxy as the
// owner, shares a view-only link with a guest, and checks isolation and cleanup.
// Never touches the compose stack.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Node } from "../../tests/harness.mjs";
import { createStore } from "../../store/server.mjs";
import { createHamstr } from "../server.mjs";
import { Browser, mockIdp } from "./helpers.mjs";

const SHELL = "hamstr.test";
const ORIGIN = { origin: `http://${SHELL}` };
const FORM = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
const dir = mkdtempSync(join(tmpdir(), "hamstr-e2e-"));
const node = new Node(Number(process.env.TEST_HAMSTR_PORT ?? 8790));
const store = createStore({ dataDir: join(dir, "store"), rateLimit: false, logging: false });
const idp = await mockIdp();
let hamstr;
const ms = (t) => `${Math.round(performance.now() - t)} ms`;

try {
	const storeBase = `http://127.0.0.1:${(await store.listen(0, "127.0.0.1")).port}`;
	const reg = await fetch(`${storeBase}/api/v1/publishers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "e2e", password: "correct horse battery" }),
	});
	const { token } = await reg.json();
	const config = join(dir, "cli-config.json");
	writeFileSync(config, `${JSON.stringify({ store: storeBase, token, publisher: "e2e" })}\n`, { mode: 0o600 });
	chmodSync(config, 0o600);
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "store", "cli", "hamstr.mjs"), "publish", join(import.meta.dirname, "..", "..", "store", "test", "fixtures", "pinboard")], {
			env: { ...process.env, HAMSTR_CLI_CONFIG: config, HAMSTR_STORE: storeBase },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		child.on("close", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`publish failed:\n${out}`))));
	});
	console.log("published pinboard through the hamstr CLI");

	await node.start();
	hamstr = createHamstr({
		dataDir: join(dir, "hamstr"),
		shellHost: SHELL,
		grainDomain: "grains.test",
		scheme: "http",
		store: storeBase,
		celldApi: `http://127.0.0.1:${node.port}`,
		adminToken: node.adminToken,
		proxyToken: node.proxyToken,
		secret: "e2e-secret",
		oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
		admins: ["ada@example.com"],
		logging: false,
	});
	const port = (await hamstr.listen(0, "127.0.0.1")).port;

	const signIn = async (user) => {
		const b = new Browser(port);
		idp.nextUser = user;
		const start = await b.request("GET", "/auth/login", { host: SHELL });
		const back = await fetch(start.headers.location, { redirect: "manual" });
		const cb = new URL(back.headers.get("location"));
		assert.equal((await b.request("GET", cb.pathname + cb.search, { host: SHELL })).status, 303);
		return b;
	};
	const api = (b, method, path, json) => b.request(method, path, { host: SHELL, headers: ORIGIN, ...(json !== undefined && { json }) });
	const go = (b, absolute) => {
		const u = new URL(absolute);
		return b.request("GET", u.pathname + u.search, { host: u.hostname });
	};
	const host = (id) => `grain-${id}.grains.test`;

	const ada = await signIn({ sub: "u-ada", email: "ada@example.com", name: "Ada Lovelace" });
	let t = performance.now();
	const installed = await api(ada, "POST", "/api/apps", { slug: "pinboard" });
	assert.equal(installed.status, 200, installed.text);
	console.log(`installed pinboard (download, verify, upload, boot check): ${ms(t)}`);

	t = performance.now();
	const kitchen = (await api(ada, "POST", "/api/grains", { slug: "pinboard", title: "Kitchen" })).json.grain;
	console.log(`created grain ${kitchen.id}: ${ms(t)}`);
	const garage = (await api(ada, "POST", "/api/grains", { slug: "pinboard", title: "Garage" })).json.grain;

	// The grain is invisible to anything but the proxy.
	assert.equal((await node.request("GET", "/", { host: host(kitchen.id) })).status, 404);
	assert.equal((await node.request("GET", "/", { host: host(kitchen.id), headers: { "x-hamstr-permissions": "pin,moderate" } })).status, 404);

	// Owner: pin through the proxy; the app knows who she is without any login code.
	assert.equal((await go(ada, (await api(ada, "POST", `/api/grains/${kitchen.id}/open`, { path: "/" })).json.url)).status, 303);
	const who = (await ada.request("GET", "/whoami", { host: host(kitchen.id) })).json;
	assert.deepEqual({ name: who.name, role: who.role, pin: who.pin, moderate: who.moderate }, { name: "Ada Lovelace", role: "owner", pin: true, moderate: true });
	assert.match(who.id, /^[a-f0-9]{32}$/);
	const pinned = await ada.request("POST", "/pin", { host: host(kitchen.id), headers: FORM, body: "text=Buy+oat+milk&color=leaf" });
	assert.equal(pinned.status, 303, pinned.text);
	const board = await ada.request("GET", "/", { host: host(kitchen.id) });
	assert.match(board.text, /Buy oat milk/);
	assert.match(board.text, /Ada Lovelace · owner/);
	assert.match(board.text, /Pin it/);

	// Download data: Pinboard's export path, called by Hamstr as the owner.
	const exported = await ada.request("GET", `/api/grains/${kitchen.id}/export`, { host: SHELL, headers: { "sec-fetch-site": "same-origin" } });
	assert.equal(exported.status, 200, exported.text);
	assert.match(exported.headers["content-disposition"], /filename="Kitchen \d{4}-\d{2}-\d{2}\.json"/);
	assert.deepEqual(exported.json.pins.map((p) => [p.text, p.author]), [["Buy oat milk", "Ada Lovelace"]]);

	// Backup and restore: celld's dump of the board's object, for any app.
	t = performance.now();
	const backup = await ada.request("GET", `/api/grains/${kitchen.id}/backup`, { host: SHELL, headers: { "sec-fetch-site": "same-origin" } });
	assert.equal(backup.status, 200, backup.text);
	assert.match(backup.headers["content-disposition"], /filename="Kitchen \d{4}-\d{2}-\d{2}\.hamstr-backup"/);
	const lines = backup.text.trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual([lines[0].type, lines[1].type, lines.at(-1).type], ["hamstr-backup", "celld-dump", "end"]);
	assert.ok(lines.some((l) => l.type === "rows" && JSON.stringify(l.rows).includes("Buy oat milk")), "the pin is in the backup");
	console.log(`backup of a board: ${ms(t)}, ${backup.text.length} bytes`);
	await ada.request("POST", "/pin", { host: host(kitchen.id), headers: FORM, body: "text=Pinned+after+the+backup&color=sky" });
	assert.match((await ada.request("GET", "/", { host: host(kitchen.id) })).text, /Pinned after the backup/);
	const upload = (method, path) =>
		ada.request(method, path, { host: SHELL, headers: { ...ORIGIN, "content-type": "application/octet-stream" }, body: backup.text });
	t = performance.now();
	const restored = await upload("PUT", `/api/grains/${kitchen.id}/backup`);
	assert.equal(restored.status, 200, restored.text);
	console.log(`restore (safety copy, then restore): ${ms(t)}`);
	const after = (await ada.request("GET", "/", { host: host(kitchen.id) })).text;
	assert.match(after, /Buy oat milk/);
	assert.doesNotMatch(after, /Pinned after the backup/);
	// The app keeps working on restored data.
	assert.equal((await ada.request("POST", "/pin", { host: host(kitchen.id), headers: FORM, body: "text=Still+works&color=sun" })).status, 303);
	assert.match((await ada.request("GET", "/", { host: host(kitchen.id) })).text, /Still works/);
	// Import: a new board from the backup.
	const imported = await upload("POST", "/api/apps/pinboard/import");
	assert.equal(imported.status, 201, imported.text);
	const copy = imported.json.grain;
	await go(ada, (await api(ada, "POST", `/api/grains/${copy.id}/open`, { path: "/" })).json.url);
	const copyBoard = (await ada.request("GET", "/", { host: host(copy.id) })).text;
	assert.match(copyBoard, /Buy oat milk/);
	assert.doesNotMatch(copyBoard, /Still works/);
	await api(ada, "POST", `/api/grains/${copy.id}/trash`, {});
	assert.equal((await api(ada, "DELETE", `/api/grains/${copy.id}`)).status, 200);

	t = performance.now();
	const N = 50;
	for (let i = 0; i < N; i++) assert.equal((await ada.request("GET", "/whoami", { host: host(kitchen.id) })).status, 200);
	const viaProxy = (performance.now() - t) / N;
	t = performance.now();
	for (let i = 0; i < N; i++) assert.equal((await node.request("GET", "/whoami", { host: host(kitchen.id), headers: { "x-celld-proxy-token": node.proxyToken } })).status, 200);
	const direct = (performance.now() - t) / N;
	console.log(`GET /whoami, mean of ${N}: ${viaProxy.toFixed(1)} ms through Hamstr, ${direct.toFixed(1)} ms straight to celld`);

	// Grains do not share data.
	await go(ada, (await api(ada, "POST", `/api/grains/${garage.id}/open`, { path: "/" })).json.url);
	assert.match((await ada.request("GET", "/", { host: host(garage.id) })).text, /Nothing pinned yet/);

	// Nobody else gets in: another signed-in person cannot open the board.
	const eve = await signIn({ sub: "u-eve", email: "eve@example.com", name: "Eve" });
	assert.equal((await api(eve, "POST", `/api/grains/${kitchen.id}/open`, { path: "/" })).status, 404);
	assert.equal((await eve.request("GET", "/", { host: host(kitchen.id) })).status, 401);

	// Delete forever: the celld site and its objects are gone.
	await api(ada, "POST", `/api/grains/${garage.id}/trash`, {});
	assert.equal((await api(ada, "DELETE", `/api/grains/${garage.id}`)).status, 200);
	assert.equal((await node.request("GET", "/", { host: host(garage.id), headers: { "x-celld-proxy-token": node.proxyToken } })).status, 404);
	const overview = (await node.admin("GET", "/overview")).json();
	const sites = overview.sites.map((s) => s.id);
	assert.ok(sites.includes(host(kitchen.id)), "the remaining grain is listed");
	assert.ok(!sites.includes(host(garage.id)), "deleted grain is not listed");
	assert.ok(!sites.some((s) => s.includes("probe")), "install probe was cleaned up");
	assert.ok(overview.objects.some((o) => o.site === host(kitchen.id) && o.className === "Board"), "the kitchen board has its object");
	assert.ok(!overview.objects.some((o) => o.site === host(garage.id)), "deleted grain left no objects");
	assert.ok(!overview.deploys.some((d) => d.site === host(garage.id) || d.site.includes("probe")), "no deploy history left behind");

	// Pinboard is single-instance: Home opens the one board that is left.
	const opened = await api(ada, "POST", "/api/apps/pinboard/open", {});
	assert.equal(opened.status, 200, opened.text);
	assert.equal(opened.json.grain.id, kitchen.id);
	console.log("e2e: install, grains, identity, export, backup and restore, privacy and deletion — OK");
} finally {
	await hamstr?.close();
	await node.stop();
	await store.close();
	await idp.close();
	rmSync(dir, { recursive: true, force: true });
}
