// The install side of Hamstr names: keeps this install's hostname pointed at
// its address and its wildcard certificate current, and writes the result to
//
//   $DATA/tls/cert.pem   certificate chain for <host> and *.<host>
//   $DATA/tls/key.pem    its private key (never leaves this machine)
//   $DATA/tls/hostname   <host>
//
// for whatever terminates TLS to pick up. Two modes:
//
//   HOSTNAME_MODE=service (default)  register with a Hamstr names service
//       (NAME_SERVICE_URL; the public one, or one you run yourself), keep the
//       address current and solve DNS-01 through it.
//   HOSTNAME_MODE=domain             your own domain (DOMAIN) at a DNS provider
//       lego supports (DNS_PROVIDER plus that provider's variables, see
//       `lego dnshelp`). No names service is involved; you point *.DOMAIN at
//       this machine yourself.
//
// Commands: `run` (default: forever, refreshing every REFRESH_HOURS),
// `once`, and `release` (give the hostname back to the service).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = process.env;
const DATA = env.HAMSTR_DATA || "/data";
const STATE_DIR = join(DATA, "names");
const STATE_FILE = join(STATE_DIR, "state.json");
const TLS_DIR = join(DATA, "tls");
const LEGO = env.LEGO_BIN || "lego";
const CERT_NAME = "hamstr";
const MODE = env.HOSTNAME_MODE || "service";

const log = (msg) => console.log(`names-agent: ${msg}`);

function writePrivate(path, data) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, data, { mode: 0o600 });
	renameSync(tmp, path);
}

function serviceUrl() {
	const url = env.NAME_SERVICE_URL?.replace(/\/+$/, "");
	if (!url) throw new Error("NAME_SERVICE_URL is not set");
	if (!/^https:\/\//.test(url) && !/^(1|true)$/.test(env.ALLOW_INSECURE_SERVICE ?? ""))
		throw new Error("NAME_SERVICE_URL must be https:// (the token travels with every request)");
	return url;
}

async function call(method, path, { token, body } = {}) {
	const res = await fetch(`${serviceUrl()}${path}`, {
		method,
		headers: {
			...(token && { authorization: `Bearer ${token}` }),
			...(body && { "content-type": "application/json" }),
		},
		body: body && JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	const data = res.status === 204 ? null : await res.json().catch(() => null);
	if (!res.ok) {
		const err = new Error(`${method} ${path}: ${res.status} ${data?.error ?? ""}`.trim());
		err.status = res.status;
		throw err;
	}
	return data;
}

function loadState() {
	if (!existsSync(STATE_FILE)) return null;
	const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
	// A registration from another service (NAME_SERVICE_URL changed) is not ours to use.
	return state.service === serviceUrl() ? state : null;
}

// Registers on first start, and again if the service no longer knows the
// token (released, or expired after a long time offline).
async function ensureRegistration() {
	let state = loadState();
	if (state) {
		try {
			await call("GET", "/v1/install", { token: state.token });
			return state;
		} catch (err) {
			if (err.status !== 401) throw err;
			log(`the service no longer knows ${state.hostname}; registering a new name`);
		}
	}
	const reg = await call("POST", "/v1/register");
	state = { service: serviceUrl(), id: reg.id, hostname: reg.hostname, token: reg.token };
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	writePrivate(STATE_FILE, JSON.stringify(state, null, "\t"));
	log(`registered ${state.hostname}`);
	return state;
}

async function tailscaleIp(flag) {
	try {
		const { stdout } = await run("tailscale", ["ip", flag], { timeout: 10_000 });
		return stdout.trim().split("\n")[0] || null;
	} catch {
		return null;
	}
}

// ADDRESS_IPV4 / ADDRESS_IPV6 win; otherwise ask Tailscale.
async function currentAddress() {
	const ipv4 = env.ADDRESS_IPV4 || (await tailscaleIp("-4"));
	const ipv6 = env.ADDRESS_IPV6 || (env.ADDRESS_IPV4 ? null : await tailscaleIp("-6"));
	if (!ipv4 && !ipv6) throw new Error("no address: set ADDRESS_IPV4/ADDRESS_IPV6 or run Tailscale");
	return { ipv4, ipv6 };
}

function legoArgs(domain, dnsProvider) {
	const args = [
		"run",
		"--accept-tos",
		"--path", join(STATE_DIR, "lego"),
		"--cert.name", CERT_NAME,
		"--domains", domain,
		"--domains", `*.${domain}`,
		"--force-cert-domains", // a new hostname means a new certificate, not a renewal
		"--dns", dnsProvider,
		"--no-random-sleep",
		"--log.format", "text",
	];
	if (env.ACME_SERVER) args.push("--server", env.ACME_SERVER);
	if (env.ACME_EMAIL) args.push("--email", env.ACME_EMAIL);
	if (env.DNS_RESOLVERS) args.push("--dns.resolvers", env.DNS_RESOLVERS);
	return args;
}

function runLego(args, extraEnv) {
	return new Promise((ok, fail) => {
		const child = spawn(LEGO, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", fail);
		child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`lego exited with ${code}`))));
	});
}

// Copies lego's files to $DATA/tls when they changed. Returns true if they did.
function publish(hostname) {
	const dir = join(STATE_DIR, "lego", "certificates");
	const cert = readFileSync(join(dir, `${CERT_NAME}.crt`));
	const key = readFileSync(join(dir, `${CERT_NAME}.key`));
	mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
	const digest = (b) => createHash("sha256").update(b).digest("hex");
	const current = join(TLS_DIR, "cert.pem");
	const unchanged =
		existsSync(current) &&
		digest(readFileSync(current)) === digest(cert) &&
		readFileSync(join(TLS_DIR, "hostname"), "utf8").trim() === hostname;
	if (unchanged) return false;
	// Key first: a reader that sees the new certificate must find its key.
	writePrivate(join(TLS_DIR, "key.pem"), key);
	writePrivate(join(TLS_DIR, "cert.pem"), cert);
	writePrivate(join(TLS_DIR, "hostname"), `${hostname}\n`);
	return true;
}

async function refresh() {
	let hostname;
	if (MODE === "service") {
		const state = await ensureRegistration();
		const address = await currentAddress();
		await call("PUT", "/v1/address", { token: state.token, body: address });
		log(`${state.hostname} → ${[address.ipv4, address.ipv6].filter(Boolean).join(", ")}`);
		await runLego(legoArgs(state.hostname, "httpreq"), {
			HTTPREQ_ENDPOINT: `${serviceUrl()}/v1`,
			HTTPREQ_USERNAME: state.id,
			HTTPREQ_PASSWORD: state.token,
		});
		hostname = state.hostname;
	} else if (MODE === "domain") {
		if (!env.DOMAIN || !env.DNS_PROVIDER) throw new Error("HOSTNAME_MODE=domain needs DOMAIN and DNS_PROVIDER");
		mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
		hostname = env.DOMAIN.toLowerCase().replace(/\.$/, "");
		await runLego(legoArgs(hostname, env.DNS_PROVIDER), {});
	} else {
		throw new Error(`unknown HOSTNAME_MODE "${MODE}" (service or domain)`);
	}

	if (publish(hostname)) {
		log(`new certificate for ${hostname} and *.${hostname} in ${TLS_DIR}`);
		if (env.ON_CERT_CHANGE) {
			try {
				await run("sh", ["-c", env.ON_CERT_CHANGE], { timeout: 60_000 });
			} catch (err) {
				log(`ON_CERT_CHANGE failed: ${err.message}`);
			}
		}
	}
	return hostname;
}

async function release() {
	const state = loadState();
	if (!state) return log("nothing registered");
	await call("DELETE", "/v1/install", { token: state.token });
	writePrivate(STATE_FILE, "{}");
	log(`released ${state.hostname}`);
}

const command = process.argv[2] ?? "run";
if (command === "once") {
	await refresh();
} else if (command === "release") {
	await release();
} else if (command === "run") {
	const hours = Number(env.REFRESH_HOURS || 6);
	// Retry quickly after a failure, then back to the normal interval.
	for (;;) {
		let wait = hours * 3_600_000;
		try {
			await refresh();
		} catch (err) {
			log(`refresh failed: ${err.message}`);
			wait = Math.min(wait, 10 * 60_000);
		}
		await new Promise((ok) => setTimeout(ok, wait));
	}
} else {
	console.error("usage: agent.mjs [run|once|release]");
	process.exit(2);
}
