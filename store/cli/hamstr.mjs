#!/usr/bin/env node
// Hamstr CLI: publish apps to the Hamstr Store, install them into a celld node.
//
//   hamstr register <name> --store <url>
//   hamstr login <name> --store <url>
//   hamstr publish <site-dir> [--no-build] [--source <file.tgz>] [--store <url>]
//   hamstr search [query] / hamstr info <app>
//   hamstr install <app>[@version] --host <hostname> [--allow-egress] [--yes]
//   hamstr update <app>|--all / hamstr list / hamstr report <app>@<version> <reason>
//
// Tokens live in ~/.config/hamstr/config.json (0600). HAMSTR_PUBLISHER_TOKEN overrides the
// stored token, HAMSTR_STORE the store, HAMSTR_CLI_CONFIG the config path.
// A config left by the CLI's old name (~/.config/cubby) is still read.
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { once } from "node:events";
import { pack as tarPack } from "tar-stream";
import { readBundle } from "../../packages/app-format/bundle.mjs";
import { parseManifest, validatePublisherName, validateSlug, validateVersion } from "../../packages/app-format/manifest.mjs";

const REPO = resolve(process.env.HAMSTR_REPO ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const configDir = (name) => (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, name) : join(homedir(), ".config", name));
const CONFIG_DIR = existsSync(join(configDir("cubby"), "config.json")) && !existsSync(join(configDir("hamstr"), "config.json")) ? configDir("cubby") : configDir("hamstr");
const CONFIG_PATH = process.env.HAMSTR_CLI_CONFIG ?? join(CONFIG_DIR, "config.json");
const INSTALLED_PATH = join(dirname(CONFIG_PATH), "installed.json");
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const die = (message) => {
	throw new Error(message);
};

function readJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") return fallback;
		throw new Error(`${path}: ${err.message}`);
	}
}
function writePrivate(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

const config = () => readJson(CONFIG_PATH, {});
const installed = () => readJson(INSTALLED_PATH, {});
function saveConfig(next) {
	writePrivate(CONFIG_PATH, { ...config(), ...next });
}
function saveInstalled(next) {
	writePrivate(INSTALLED_PATH, next);
}

function requireStore(opts) {
	const raw = opts.store ?? process.env.HAMSTR_STORE ?? config().store;
	if (!raw) die("no store configured: pass --store <url> or run `hamstr login` first");
	let url;
	try {
		url = new URL(raw);
	} catch {
		die(`bad store URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") die("store URL must be http(s)");
	return url.origin + url.pathname.replace(/\/+$/, "");
}
function requireToken(opts) {
	const token = process.env.HAMSTR_PUBLISHER_TOKEN ?? config().token;
	if (!token) die("no publisher token: run `hamstr login <name> --store <url>` or set HAMSTR_PUBLISHER_TOKEN");
	return token;
}

async function call(url, { method = "GET", json, token, body, headers = {} } = {}) {
	const res = await fetch(url, {
		method,
		headers: {
			accept: "application/json",
			...(json !== undefined ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: json !== undefined ? JSON.stringify(json) : body,
		signal: AbortSignal.timeout(120_000),
	});
	const text = await res.text();
	let parsed = {};
	try {
		parsed = JSON.parse(text);
	} catch {}
	if (!res.ok) die(parsed.error || `${method} ${url} failed: ${res.status} ${res.statusText}`);
	return parsed;
}

async function hiddenPrompt(question) {
	if (process.env.HAMSTR_PUBLISHER_PASSWORD !== undefined) return process.env.HAMSTR_PUBLISHER_PASSWORD;
	if (!process.stdin.isTTY) return readFileSync(0, "utf8").split("\n")[0] ?? "";
	process.stdout.write(question);
	return new Promise((resolvePromise) => {
		const stdin = process.stdin;
		stdin.resume();
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		let value = "";
		const cleanup = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
		};
		const onData = (chunk) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					cleanup();
					process.stdout.write("\n");
					resolvePromise(value);
					return;
				}
				if (ch === "\u0003") {
					cleanup();
					process.stdout.write("\n");
					process.exit(130);
				}
				if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
				else value += ch;
			}
		};
		stdin.on("data", onData);
	});
}

async function ask(question) {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(question)).trim());
	} finally {
		rl.close();
	}
}

function parseArgs(argv) {
	const positional = [];
	const opts = {};
	const booleans = new Set(["all", "no-build", "allow-egress", "yes", "replace"]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (eq !== -1) opts[key] = arg.slice(eq + 1);
		else if (booleans.has(arg.slice(2))) opts[key] = true;
		else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[key] = argv[++i];
		else opts[key] = true;
	}
	return { positional, opts };
}

// --- bundle creation --------------------------------------------------------

/** Pack the directory tools/pack.mjs wrote into a deterministic .tgz. */
async function makeBundle(dir) {
	const names = ["version", "code.json", ...readdirSync(join(dir, "blobs")).map((f) => `blobs/${f}`)].sort();
	const packer = tarPack();
	const chunks = [];
	packer.on("data", (chunk) => chunks.push(chunk));
	packer.entry({ name: "blobs/", type: "directory", mode: 0o755, mtime: new Date(0) });
	for (const name of names) {
		const data = readFileSync(join(dir, name));
		packer.entry({ name, size: data.length, mode: 0o644, mtime: new Date(0) }, data);
	}
	packer.finalize();
	await once(packer, "end");
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function packSite(siteDir) {
	const out = mkdtempSync(join(tmpdir(), "hamstr-pack-"));
	try {
		const result = spawnSync(process.execPath, [join(REPO, "tools", "pack.mjs"), siteDir, out], { stdio: "inherit", env: process.env });
		if (result.status !== 0) die("packing the site failed");
		return out;
	} catch (err) {
		rmSync(out, { recursive: true, force: true });
		throw err;
	}
}

// --- local celld admin helpers ---------------------------------------------

function requireCelldTools() {
	const local = Boolean(process.env.CELLD_ADMIN_API);
	const missing = [];
	if (!existsSync(join(REPO, "node", "push.sh"))) missing.push("node/push.sh");
	if (!local && !existsSync(join(REPO, "tools", "admin.sh"))) missing.push("tools/admin.sh");
	if (missing.length) die(`cannot find ${missing.join(", ")} under ${REPO}; set HAMSTR_REPO to the checkout`);
}
const composeProject = () => process.env.CELLD_COMPOSE_DIR ?? REPO;

function admin(args, input) {
	const result = spawnSync("sh", [join(REPO, "tools", "admin.sh"), ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, CELLD_COMPOSE_DIR: composeProject() },
	});
	return result;
}

/** Talk to a local celld dev node (CELLD_ADMIN_API) instead of `docker compose exec`. */
function adminRequest(method, pathname, body) {
	const base = new URL(process.env.CELLD_ADMIN_API);
	return new Promise((resolvePromise, rejectPromise) => {
		const req = httpRequest(
			{
				hostname: base.hostname,
				port: base.port || 80,
				path: `/__admin${pathname}`,
				method,
				headers: {
					Host: process.env.ADMIN_HOST ?? "admin.internal",
					authorization: `Bearer ${process.env.ADMIN_TOKEN ?? ""}`,
					...(body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
				},
			},
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, stdout: data }));
			},
		);
		req.on("error", rejectPromise);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function currentEgress(host) {
	if (process.env.CELLD_ADMIN_API) {
		const result = await adminRequest("GET", `/egress?host=${host}`);
		if (result.status === 404) return null;
		if (result.status !== 200) die(`could not read the egress allowlist: ${result.stdout.trim()}`);
		try {
			return JSON.parse(result.stdout).allow ?? [];
		} catch {
			return null;
		}
	}
	const result = admin(["GET", `/egress?host=${host}`]);
	if (result.status !== 0) return null; // no site yet (404) or no access
	try {
		return JSON.parse(result.stdout).allow ?? [];
	} catch {
		return null;
	}
}

// Whether host already serves a site, as its own id or as an alias. The egress
// endpoint answers for any hostname, so it cannot tell.
async function siteExists(host) {
	const viaApi = Boolean(process.env.CELLD_ADMIN_API);
	const result = viaApi ? await adminRequest("GET", "/overview") : admin(["GET", "/overview"]);
	if (result.status !== (viaApi ? 200 : 0)) die(`could not list this node's sites: ${String(result.stdout ?? "").trim()}`);
	try {
		const { sites = [] } = JSON.parse(result.stdout);
		return sites.some((site) => site.id === host || site.aliases?.includes(host));
	} catch {
		die("could not read this node's site list");
	}
}

async function setEgress(host, allow) {
	if (process.env.CELLD_ADMIN_API) {
		const result = await adminRequest("PUT", `/egress?host=${host}`, JSON.stringify(allow));
		// Nodes older than the store installer's pre-seed support refuse an allowlist for a
		// site that does not exist yet. With nothing to grant, that is harmless:
		// deploy first, the list is empty either way.
		if (result.status === 404 && allow.length === 0) return;
		if (result.status !== 200) die(`could not set the egress allowlist: ${result.stdout.trim()}`);
		return;
	}
	const result = admin(["PUT", `/egress?host=${host}`, "-"], JSON.stringify(allow));
	if (result.status !== 0) {
		if (allow.length === 0 && /no site for/.test(result.stderr || result.stdout)) return;
		die(`could not set the egress allowlist: ${(result.stderr || result.stdout).trim()}`);
	}
}

function pushBundle(bundle, host, watch) {
	const raw = gunzipSync(bundle);
	if (process.env.CELLD_ADMIN_API) {
		const args = [join(REPO, "node", "push.sh"), host];
		if (watch !== undefined) args.push("--watch", String(watch));
		const result = spawnSync("sh", args, {
			input: raw,
			stdio: ["pipe", "inherit", "inherit"],
			env: {
				...process.env,
				CELLD_ADMIN_API: process.env.CELLD_ADMIN_API,
				ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "",
				ADMIN_HOST: process.env.ADMIN_HOST ?? "admin.internal",
			},
		});
		if (result.status !== 0) die(`deploy failed (push.sh exited ${result.status})`);
		return;
	}
	const args = ["compose", "--project-directory", composeProject(), "exec", "-T", "celld", "/app/push.sh", host];
	if (watch !== undefined) args.push("--watch", String(watch));
	const result = spawnSync("docker", args, { input: raw, stdio: ["pipe", "inherit", "inherit"] });
	if (result.status !== 0) die(`deploy failed (push.sh exited ${result.status})`);
}

// --- commands ---------------------------------------------------------------

async function register(name, opts) {
	validatePublisherName(name);
	const store = requireStore(opts);
	let password = await hiddenPrompt("Password (10+ characters): ");
	if (process.stdin.isTTY && process.env.HAMSTR_PUBLISHER_PASSWORD === undefined) {
		const again = await hiddenPrompt("Repeat password: ");
		if (again !== password) die("passwords do not match");
	}
	if (password.length < 10) die("password must be at least 10 characters");
	const body = await call(`${store}/api/v1/publishers`, { method: "POST", json: { name, password } });
	password = "";
	saveConfig({ store, token: body.token, publisher: name });
	console.log(`registered ${name} at ${store}`);
	console.log(`token (shown once, also saved in ${CONFIG_PATH}): ${body.token}`);
}

async function login(name, opts) {
	const store = requireStore(opts);
	const password = await hiddenPrompt("Password: ");
	const body = await call(`${store}/api/v1/tokens`, { method: "POST", json: { name, password } });
	saveConfig({ store, token: body.token, publisher: name });
	console.log(`signed in as ${name} at ${store}`);
}

async function whoami(opts) {
	const store = requireStore(opts);
	const token = requireToken(opts);
	const body = await call(`${store}/api/v1/me`, { token });
	const used = (body.storageUsed / 1024 / 1024).toFixed(1);
	console.log(`${body.publisher.name} at ${store} — ${body.apps.length} app(s), ${used} MiB stored`);
	for (const app of body.apps) {
		const versions = app.releases.map((r) => `${r.version} (${r.status})`).join(", ");
		console.log(`  ${app.slug}: ${versions || "no releases"}`);
	}
}

async function publishRelease(dir, opts) {
	const site = resolve(dir ?? ".");
	// cubby.json is the manifest's old name.
	const manifestPath = opts.manifest ? resolve(opts.manifest) : [join(site, "hamstr.json"), join(site, "cubby.json")].find(existsSync) ?? join(site, "hamstr.json");
	if (!existsSync(manifestPath)) die(`missing ${manifestPath} (the app manifest; see store/README.md)`);
	const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
	const slug = manifest.slug;
	const store = requireStore(opts);
	const token = requireToken(opts);

	if (!opts.noBuild) {
		const pkg = join(site, "package.json");
		if (existsSync(pkg) && readFileSync(pkg, "utf8").includes('"build"')) {
			console.log("hamstr: building");
			const result = spawnSync("npm", ["run", "build"], { cwd: site, stdio: "inherit", env: process.env });
			if (result.status !== 0) die("the site build failed");
		}
	}
	const packed = packSite(site);
	let bundle;
	try {
		bundle = await makeBundle(packed);
		const check = join(packed, "bundle.tgz");
		writeFileSync(check, bundle);
		await readBundle(check);
	} finally {
		rmSync(packed, { recursive: true, force: true });
	}
	const digest = createHash("sha256").update(bundle).digest("hex");

	const created = await call(`${store}/api/v1/apps/${slug}/releases`, { method: "POST", token, json: { manifest } });
	const uploaded = await call(`${store}${created.upload.url}`, {
		method: "PUT",
		token,
		headers: { "content-type": "application/gzip", "x-content-sha256": digest },
		body: bundle,
	});
	if (opts.source) {
		const source = readFileSync(resolve(opts.source));
		if (source.length > 16 * 1024 * 1024) die("source archive must be at most 16 MiB");
		await call(`${store}/api/v1/releases/${created.release.id}/source`, {
			method: "PUT",
			token,
			headers: { "content-type": "application/gzip" },
			body: source,
		});
	}
	const status = uploaded.release.status;
	console.log(`published ${slug}@${manifest.version}${status === "pending" ? " (waiting for operator review)" : ""}`);
	console.log(`  ${store}/apps/${slug}`);
	console.log(`  sha256 ${digest}`);
}

async function search(query, opts) {
	const store = requireStore(opts);
	const params = new URLSearchParams({ limit: "30" });
	if (query) params.set("q", query);
	const body = await call(`${store}/api/v1/apps?${params}`);
	if (!body.apps.length) {
		console.log("no apps found");
		return;
	}
	for (const app of body.apps) {
		console.log(`${app.slug.padEnd(24)} ${app.version.padEnd(10)} ${app.name} — ${app.summary}`);
	}
}

async function info(slug, opts) {
	const store = requireStore(opts);
	const body = await call(`${store}/api/v1/apps/${validateSlug(slug)}`);
	const { app, releases } = body;
	console.log(`${app.icon || "▫"}  ${app.name} (${app.slug})`);
	console.log(app.summary);
	console.log(`publisher ${app.publisher} · version ${app.version} · license ${app.license}`);
	if (app.tags.length) console.log(`tags: ${app.tags.join(", ")}`);
	const latest = releases.find((r) => r.status === "published");
	console.log(`network: ${latest?.manifest?.egress?.length ? latest.manifest.egress.join(", ") : "none"}`);
	console.log(`install: hamstr install ${app.slug} --store ${store} --host <your-host>`);
}

async function install(slugArg, opts, { previousEgress = [], quiet = false } = {}) {
	requireCelldTools();
	const [slug, wanted] = slugArg.includes("@") ? slugArg.split("@") : [slugArg, undefined];
	validateSlug(slug);
	const host = opts.host;
	if (!host || !HOSTNAME.test(host) || host === "admin.internal") die("--host must be the site id (a hostname), not an alias");
	if (wanted) validateVersion(wanted);
	const prior = installed()[host];
	if (prior && prior.slug !== slug && !opts.replace) {
		die(`${host} already runs ${prior.slug}; use another --host, or --replace (the new app would be able to read its data)`);
	}
	if (prior && prior.slug !== slug && opts.replace) {
		console.log(`warning: replacing ${prior.slug} on ${host}; ${slug} will run against the same Durable Objects and data`);
	}
	if (!prior && !opts.replace && (await siteExists(host))) {
		die(`${host} is already a site on this node that this CLI did not install; pick a free --host, or --replace to overwrite it (the app would run against its data)`);
	}
	if (opts.watch !== undefined) {
		if (typeof opts.watch !== "string" || !/^\d+$/.test(opts.watch)) die("--watch needs a number of seconds");
	}

	const store = requireStore(opts);
	const detail = await call(`${store}/api/v1/apps/${slug}`);
	const release = wanted ? detail.releases.find((r) => r.version === wanted) : detail.releases.find((r) => r.status === "published");
	if (!release) die(wanted ? `no release ${slug}@${wanted}` : `${slug} has no published release`);
	if (release.status !== "published") die(`${slug}@${release.version} is ${release.status}, not published`);
	const manifest = release.manifest;

	const added = (manifest.egress ?? []).filter((h) => !previousEgress.includes(h));
	if (added.length && !opts.allowEgress) {
		if (!process.stdin.isTTY) {
			die(`this release wants network access to ${added.join(", ")}; review it, then re-run with --allow-egress`);
		}
		console.log(`${slug} wants to fetch:`);
		for (const h of manifest.egress) console.log(`  ${h}${added.includes(h) ? "  (new)" : ""}`);
		if (!(await ask("Grant this network access? [y/N] "))) die("aborted: no network access granted");
	}

	if (!quiet && !opts.yes) {
		console.log(`install ${manifest.name} ${release.version} (${release.bundleSize ? `${(release.bundleSize / 1024 / 1024).toFixed(1)} MiB` : "bundle"})`);
		console.log(`  from ${store}, to ${host}`);
		console.log(`  network: ${manifest.egress?.length ? manifest.egress.join(", ") : "none"}`);
		if (!(await ask("Continue? [Y/n] "))) die("aborted");
	}

	// Download and verify before touching the local node.
	const res = await fetch(`${store}/api/v1/apps/${slug}/releases/${release.version}/download`, { signal: AbortSignal.timeout(120_000) });
	if (!res.ok) {
		let message = `${res.status} ${res.statusText}`;
		try {
			message = (await res.json()).error ?? message;
		} catch {}
		die(`download failed: ${message}`);
	}
	const bundle = Buffer.from(await res.arrayBuffer());
	const digest = createHash("sha256").update(bundle).digest("hex");
	if (!release.bundleSha256) die("the store did not publish a SHA-256 for this release; refusing to install an unpinned bundle");
	if (digest !== release.bundleSha256) die("downloaded bundle does not match the catalog SHA-256");

	const tmp = mkdtempSync(join(tmpdir(), "hamstr-install-"));
	const file = join(tmp, "bundle.tgz");
	writeFileSync(file, bundle);
	try {
		// Validate every entry before the bytes reach the celld node. The original
		// tar.gz is what push.sh consumes, so nothing is unpacked on this machine.
		await readBundle(file);

		const before = await currentEgress(host);
		await setEgress(host, manifest.egress ?? []);
		try {
			pushBundle(bundle, host, opts.watch);
		} catch (err) {
			if (before) await setEgress(host, before);
			throw err;
		}
		const all = installed();
		all[host] = {
			slug,
			version: release.version,
			codeVersion: null,
			bundleSha256: digest,
			egress: manifest.egress ?? [],
			installedAt: new Date().toISOString(),
		};
		saveInstalled(all);
		console.log(`installed ${slug}@${release.version} at ${host}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function update(target, opts) {
	const all = installed();
	const entries = Object.entries(all).filter(([, value]) => opts.all || value.slug === target);
	if (!entries.length) die(opts.all ? "nothing installed" : `no installed app called ${target}`);
	for (const [host, value] of entries) {
		const store = requireStore(opts);
		const detail = await call(`${store}/api/v1/apps/${value.slug}`);
		const latest = detail.releases.find((r) => r.status === "published");
		if (!latest) {
			console.log(`${value.slug}: no published release, skipping`);
			continue;
		}
		if (latest.version === value.version) {
			console.log(`${value.slug}@${value.version} at ${host} is up to date`);
			continue;
		}
		console.log(`${value.slug}: ${value.version} -> ${latest.version} at ${host}`);
		await install(`${value.slug}@${latest.version}`, { ...opts, host, yes: opts.yes }, { previousEgress: value.egress ?? [] });
	}
}

async function report(slugArg, reason, opts) {
	if (!slugArg?.includes("@")) die("usage: hamstr report <app>@<version> <reason>");
	const [slug, version] = slugArg.split("@");
	validateSlug(slug);
	validateVersion(version);
	if (!reason || reason.trim().length < 5) die("give a reason of at least 5 characters");
	const store = requireStore(opts);
	await call(`${store}/api/v1/apps/${slug}/releases/${version}/report`, { method: "POST", json: { reason: reason.trim() } });
	console.log(`reported ${slug}@${version} to ${store}`);
}

async function list(opts) {
	void opts;
	const all = installed();
	const hosts = Object.keys(all);
	if (!hosts.length) {
		console.log("nothing installed yet");
		return;
	}
	for (const host of hosts) {
		const value = all[host];
		console.log(`${value.slug}@${value.version}`.padEnd(32) + host + (value.egress?.length ? `  (egress: ${value.egress.join(", ")})` : ""));
	}
}

function usage() {
	console.log(`hamstr — little apps for your own node

  register <name> --store <url>       create a publisher and save a token
  login <name> --store <url>          get a new token for an existing publisher
  whoami [--store <url>]
  publish <dir> [--no-build] [--source <file.tgz>] [--store <url>]
  search [query] / info <app>
  install <app>[@version] --host <host> [--allow-egress] [--yes] [--replace] [--watch <s>]
  update <app> | --all                install the latest published release
  list                                apps installed on this machine
  report <app>@<version> <reason>

Environment: HAMSTR_STORE, HAMSTR_PUBLISHER_TOKEN, HAMSTR_CLI_CONFIG, HAMSTR_REPO,
CELLD_COMPOSE_DIR. Tokens are stored in ${CONFIG_PATH} (mode 600).
`);
}

async function main() {
	const { positional, opts } = parseArgs(process.argv.slice(2));
	const [command, ...rest] = positional;
	switch (command) {
		case "register": {
			if (!rest[0]) die("usage: hamstr register <name>");
			return register(rest[0], opts);
		}
		case "login": {
			if (!rest[0]) die("usage: hamstr login <name>");
			return login(rest[0], opts);
		}
		case "whoami":
			return whoami(opts);
		case "publish":
			return publishRelease(rest[0] ?? ".", opts);
		case "search":
			return search(rest.join(" "), opts);
		case "info": {
			if (!rest[0]) die("usage: hamstr info <app>");
			return info(rest[0], opts);
		}
		case "install": {
			if (!rest[0]) die("usage: hamstr install <app>[@version] --host <host>");
			return install(rest[0], opts);
		}
		case "update":
			return update(rest[0], opts);
		case "list":
			return list(opts);
		case "report":
			return report(rest[0], rest.slice(1).join(" "), opts);
		case "help":
		case undefined:
		case "--help":
			return usage();
		default:
			die(`unknown command: ${command}\n\n${usage()}`);
	}
}

main().catch((err) => {
	console.error(`hamstr: ${err.message}`);
	process.exit(1);
});
