// End-to-end install check against a throwaway local celld dev node.
//
//   node store/test/e2e-install.ts
//
// Starts the store on an ephemeral port and the repo's celld harness on
// TEST_INSTALL_PORT (default 8780), publishes the demo app through the real CLI,
// installs it through the real CLI, and drives the installed app. Needs celld on
// PATH and tools' npm dependencies; never touches the compose stack.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { Node } from "../../tests/harness.ts";
import { createStore } from "../server.ts";

const dir = mkdtempSync(join(tmpdir(), "store-e2e-"));
const config = join(dir, "config.json");
const store = createStore({ dataDir: join(dir, "data"), rateLimit: false, logging: false, adminToken: "e2e-admin" });
const node = new Node(Number(process.env.TEST_INSTALL_PORT ?? 8780));
try {
	const address = await store.listen(0, "127.0.0.1");
	const base = `http://127.0.0.1:${address.port}`;
	const reg = await fetch(`${base}/api/v1/publishers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "e2e", password: "correct horse battery" }),
	});
	const registered = await reg.text();
	assert.equal(reg.status, 201, registered);
	const { token } = JSON.parse(registered);
	writeFileSync(config, `${JSON.stringify({ store: base, token, publisher: "e2e" })}\n`, { mode: 0o600 });
	chmodSync(config, 0o600);

	const cli = ["node", join(import.meta.dirname, "..", "cli", "hamstr.ts")];
	// Async spawn, not spawnSync: the store runs in this process, so a blocked
	// event loop would stop it from answering the CLI it is waiting for.
	const run = (args, extraEnv = {}) =>
		new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(cli[0], [cli[1], ...args], {
				env: { ...process.env, HAMSTR_CLI_CONFIG: config, ...extraEnv },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("error", rejectPromise);
			child.on("close", (code) => {
				if (code !== 0) rejectPromise(new Error(`${args.join(" ")} failed:\n${stdout}\n${stderr}`));
				else resolvePromise(stdout);
			});
		});

	console.log(await run(["publish", join(import.meta.dirname, "fixtures", "secret-santa")], { HAMSTR_STORE: base }));
	await node.start();
	console.log(
		await run(["install", "secret-santa", "--host", "demo.test", "--yes", "--watch", "0"], {
			CELLD_ADMIN_API: `http://127.0.0.1:${node.port}`,
			ADMIN_TOKEN: node.adminToken,
			ADMIN_HOST: "admin.internal",
		}),
	);

	const home = await node.request("GET", "/", { host: "demo.test" });
	assert.equal(home.status, 200);
	assert.match(home.text, /Secret Santa/);
	const form = { headers: { "content-type": "application/x-www-form-urlencoded" } };
	assert.equal((await node.request("POST", "/add", { host: "demo.test", body: "name=Ada", ...form })).status, 303);
	assert.equal((await node.request("POST", "/add", { host: "demo.test", body: "name=Grace", ...form })).status, 303);
	const draw = await node.request("POST", "/draw", { host: "demo.test", body: "", ...form });
	assert.equal(draw.status, 200);
	assert.match(draw.text, /Ada/);
	assert.match(draw.text, /Grace/);

	// A CLI that did not install demo.test (no record of it) must not overwrite it.
	const stranger = join(dir, "other", "config.json");
	mkdirSync(dirname(stranger), { recursive: true });
	await assert.rejects(
		run(["install", "secret-santa", "--host", "demo.test", "--yes", "--watch", "0"], {
			HAMSTR_CLI_CONFIG: stranger,
			CELLD_ADMIN_API: `http://127.0.0.1:${node.port}`,
			ADMIN_TOKEN: node.adminToken,
			ADMIN_HOST: "admin.internal",
		}),
		/already a site on this node that this CLI did not install/,
	);
	console.log("e2e: installed, served and stored data, and refused to overwrite an unknown site — OK");
} finally {
	await node.stop();
	await store.close();
	rmSync(dir, { recursive: true, force: true });
}
