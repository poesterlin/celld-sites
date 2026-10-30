// The hamstr CLI as an outside developer gets it: packed with `npm pack`,
// installed into an empty directory with npm, run from outside this repo, with
// no HAMSTR_REPO and no Docker. It registers, publishes an app copied out of
// the repo, saves a node with `hamstr node`, installs into a throwaway
// `celld dev` node over its admin API, updates it, and refuses what it must.
//
//   node store/test/e2e-cli-package.mjs
//
// Needs `celld` on PATH and network access for npm (esbuild).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Node } from "../../tests/harness.mjs";
import { createStore } from "../server.mjs";

const repo = join(import.meta.dirname, "..", "..");
const work = mkdtempSync(join(tmpdir(), "hamstr-cli-e2e-"));
const store = createStore({ dataDir: join(work, "store"), rateLimit: false, logging: false });
const node = new Node(Number(process.env.TEST_CLI_PORT ?? 8781));

function sh(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
	if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}

try {
	// 1. Pack and install the CLI like a user would.
	const tarball = sh("npm", ["pack", "--silent", "--pack-destination", work], { cwd: join(repo, "store", "cli") }).split("\n").at(-1);
	const prefix = join(work, "prefix");
	sh("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", prefix, join(work, tarball)]);
	const bin = join(prefix, "node_modules", ".bin", "hamstr");
	console.log(`installed ${tarball} into an empty prefix`);

	// 2. A store and a node, and an app outside the repo.
	await store.listen(0, "127.0.0.1");
	const storeUrl = `http://127.0.0.1:${store.server.address().port}`;
	await node.start();
	const app = join(work, "secret-santa");
	cpSync(join(repo, "store", "examples", "secret-santa"), app, { recursive: true });
	const tokenFile = join(work, "admin-token");
	writeFileSync(tokenFile, `${node.adminToken}\n`, { mode: 0o600 });

	const env = {
		PATH: process.env.PATH,
		HOME: work,
		XDG_CONFIG_HOME: join(work, "config"),
		HAMSTR_PUBLISHER_PASSWORD: "a long enough password",
	};
	const run = (args, extra = {}) =>
		new Promise((resolvePromise, rejectPromise) => {
			// Async: the store runs in this process and must keep answering.
			const child = spawn(bin, args, { cwd: work, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (out += d));
			child.on("close", (code) => (code === 0 ? resolvePromise(out) : rejectPromise(Object.assign(new Error(`hamstr ${args.join(" ")} exited ${code}:\n${out}`), { out }))));
		});

	assert.equal((await run(["--version"])).trim(), JSON.parse(readFileSync(join(repo, "store", "cli", "package.json"), "utf8")).version);

	// 3. Publish.
	await run(["register", "outsider", "--store", storeUrl]);
	const published = await run(["publish", app]);
	assert.match(published, /published secret-santa@/);
	const version = /published secret-santa@(\S+)/.exec(published)[1];
	console.log(`published secret-santa@${version} with the packaged CLI`);

	// 4. Remember the node, install, and use the app.
	await assert.rejects(run(["node", `http://127.0.0.1:${node.port}`, "--admin-token-file", join(work, "missing")]), /cannot read the admin token file/);
	const saved = await run(["node", `http://127.0.0.1:${node.port}`, "--admin-token-file", tokenFile]);
	assert.match(saved, /saved: installs go to/);
	const installed = await run(["install", "secret-santa", "--host", "santa.test", "--yes", "--watch", "2"]);
	assert.match(installed, /installed secret-santa@/);
	assert.match(installed, /check passed/);
	const home = await node.request("GET", "/", { host: "santa.test" });
	assert.equal(home.status, 200);
	assert.match(home.text, /Secret Santa/);
	const form = { headers: { "content-type": "application/x-www-form-urlencoded" } };
	assert.equal((await node.request("POST", "/add", { host: "santa.test", body: "name=Ada", ...form })).status, 303);
	assert.match(await run(["list"]), /secret-santa@\S+\s+santa\.test/);
	console.log("installed into celld dev over the admin API, no repo, no Docker");

	// 5. An update keeps the data.
	const manifestPath = join(app, "hamstr.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.version = bump(version);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	await run(["publish", app]);
	const updated = await run(["update", "secret-santa", "--yes", "--watch", "0"]);
	assert.match(updated, new RegExp(`${version.replace(/\./g, "\\.")} -> ${manifest.version.replace(/\./g, "\\.")}`));
	const after = await node.request("GET", "/", { host: "santa.test" });
	assert.match(after.text, /Ada/, "data survives the update");
	console.log(`updated to ${manifest.version}; data kept`);

	// 6. Refusals: an existing site it did not install, a version that exists.
	await assert.rejects(
		run(["install", "secret-santa", "--host", "santa.test", "--yes"], { XDG_CONFIG_HOME: join(work, "other-config"), CELLD_ADMIN_API: `http://127.0.0.1:${node.port}`, ADMIN_TOKEN: node.adminToken }),
		/already a site on this node that this CLI did not install/,
	);
	await assert.rejects(run(["publish", app]), /already exists/);
	console.log("refused to overwrite an unknown site and to republish a version");

	console.log("e2e (packaged CLI): OK");
} finally {
	await node.stop().catch(() => {});
	await store.close().catch(() => {});
	rmSync(work, { recursive: true, force: true });
}

function bump(v) {
	const parts = v.split(".").map(Number);
	parts[2] += 1;
	return parts.join(".");
}
