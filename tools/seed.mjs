#!/usr/bin/env node
// Seed (or update) a site's Durable Objects by replaying object method calls
// through the router's admin API, so data goes through the site's own code.
//
//   node tools/seed.mjs <hostname> <calls.json>              production node
//   node tools/seed.mjs --preview <site-dir> <calls.json>    local preview (tools/preview.sh)
//   node tools/seed.mjs <hostname> --call Notes main export  one call, print the result
//
// calls.json: [{ "class": "Notes", "name": "main", "method": "seed", "args": [[...]] }, ...]
// Add "version": "<id>" to a call to seed a version that is uploaded but not
// yet active. Export data with a method that returns it (e.g. Notes.export),
// then put the result into a calls file to load it elsewhere.
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = process.env.CELLD_COMPOSE_DIR
	? resolve(process.env.CELLD_COMPOSE_DIR)
	: resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const die = (msg) => {
	console.error(`seed: ${msg}`);
	process.exit(1);
};
const usage = "usage: node tools/seed.mjs <hostname>|--preview <site-dir> <calls.json> | --call <class> <name> <method> [jsonArgs]";

let target;
if (argv[0] === "--preview") {
	const state = join(resolve(argv[1] ?? die(usage)), ".celld-preview");
	if (!existsSync(join(state, "port"))) die("no running preview for that site: start it with tools/preview.sh");
	target = {
		host: "preview",
		token: readFileSync(join(state, "token"), "utf8").trim(),
		api: `http://127.0.0.1:${readFileSync(join(state, "port"), "utf8").trim()}/__admin`,
	};
	argv.splice(0, 2);
} else {
	target = { host: argv.shift() ?? die(usage) };
}

let calls;
if (argv[0] === "--call") {
	const [, cls, name, method, args = "[]"] = argv;
	if (!cls || !name || !method) die(usage);
	calls = [{ class: cls, name, method, args: JSON.parse(args) }];
} else {
	const file = argv[0] ?? die(usage);
	calls = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(calls)) die("calls file must be a JSON array");
}

/** One admin call: local preview over HTTP, production through the celld container. */
async function call(c) {
	const query = new URLSearchParams({ host: target.host, class: c.class, name: c.name, method: c.method });
	if (c.version) query.set("version", c.version);
	const body = JSON.stringify(c.args ?? []);
	if (target.api) {
		// node:http, not fetch(): fetch silently drops a custom Host header, and the
		// admin API only answers on the admin hostname.
		const url = new URL(`${target.api}/call?${query}`);
		const { status, text } = await new Promise((done, failed) => {
			const req = request(
				url,
				{
					method: "POST",
					headers: {
						host: "admin.internal",
						authorization: `Bearer ${target.token}`,
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
					},
				},
				(res) => {
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => done({ status: res.statusCode, text: data }));
				},
			);
			req.on("error", failed);
			req.end(body);
		});
		const out = JSON.parse(text);
		if (status !== 200) throw new Error(out.error ?? `HTTP ${status}`);
		return out.result;
	}
	const r = spawnSync("docker", ["compose", "--project-directory", project, "exec", "-T", "celld", "/app/admin.sh", "POST", `/call?${query}`, "-"], {
		input: body,
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error((r.stdout + r.stderr).trim().slice(0, 500));
	return JSON.parse(r.stdout).result;
}

for (const c of calls) {
	const label = `${c.class}(${c.name}).${c.method}`;
	try {
		const result = await call(c);
		if (calls.length === 1) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else console.error(`ok  ${label}`);
	} catch (e) {
		die(`${label} failed: ${e.message}`);
	}
}
