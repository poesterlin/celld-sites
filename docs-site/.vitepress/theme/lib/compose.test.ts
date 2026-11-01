// The generator's contract: every scenario produces a compose file that
// `docker compose config` accepts, with the appliance's settings in the right
// shape. Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_IMAGE_TAG,
	IMAGE_REPOSITORY,
	SCENARIOS,
	type Options,
	type Scenario,
	defaultOptions,
	generate,
	isPrivateAddress,
	portMappings,
	providerSlug,
	redirectUri,
} from "./compose.ts";

const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const hasDocker = docker.status === 0;

function options(scenario: Scenario, extra: Partial<Options> = {}): Options {
	return {
		...defaultOptions(),
		scenario,
		oidcEnabled: scenario !== "home",
		oidcIssuer: "https://idp.example.ts.net",
		oidcClientId: "client-123",
		nameServiceUrl: "https://names.example.net",
		domain: "example.com",
		proxyHost: "hamstr.example.com",
		proxyGrainDomain: "example.com",
		addressIpv4: scenario === "names" ? "100.64.0.10" : "",
		httpPort: scenario === "proxy" || scenario === "home" ? "8000" : "80",
		...extra,
	};
}

function envOf(yaml: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of yaml.split("\n")) {
		const match = /^\s+- "?([A-Z_][A-Z0-9_]*)=(.*?)"?$/.exec(line);
		if (match) map.set(match[1], match[2]);
	}
	return map;
}

function withDocker(opts: Options): { ok: boolean; error?: string; parsed?: any } {
	const g = generate(opts);
	const dir = mkdtempSync(join(tmpdir(), "hamstr-compose-"));
	try {
		writeFileSync(join(dir, "compose.yaml"), g.yaml);
		writeFileSync(join(dir, "env"), g.env.replace(/^([A-Z_][A-Z0-9_]*)=$/gm, "$1=test-value"));
		// compose reads `.env` from the project directory
		writeFileSync(join(dir, ".env"), g.env.replace(/^([A-Z_][A-Z0-9_]*)=$/gm, "$1=test-value"));
		const run = spawnSync(
			"docker",
			["compose", "-f", join(dir, "compose.yaml"), "--project-directory", dir, "config", "--format", "json"],
			{ encoding: "utf8" },
		);
		if (run.status !== 0) return { ok: false, error: run.stderr || run.stdout };
		return { ok: true, parsed: JSON.parse(run.stdout) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("defaults are a valid home-mode install", () => {
	const o = defaultOptions();
	const g = generate(o);
	assert.deepEqual(g.errors, []);
	assert.equal(o.scenario, "home");
	assert.ok(g.yaml.includes("HAMSTR_AUTH=none"));
	assert.equal(o.imageTag, DEFAULT_IMAGE_TAG);
});

test("domain scenario: wildcard TLS by DNS-01 with the provider's variables", () => {
	const g = generate(options("domain", { dnsProvider: "hetzner", acmeEmail: "ops@example.com" }));
	assert.deepEqual(g.errors, []);
	const env = envOf(g.yaml);
	assert.equal(env.get("TLS_MODE"), "domain");
	assert.equal(env.get("DOMAIN"), "example.com");
	assert.equal(env.get("DNS_PROVIDER"), "hetzner");
	assert.equal(env.get("ACME_EMAIL"), "ops@example.com");
	assert.match(env.get("HETZNER_API_TOKEN") ?? "", /^\$\{HETZNER_API_TOKEN:\?/);
	assert.deepEqual(portMappings(options("domain")), ["443:8443", "80:8000"]);
	assert.ok(g.yaml.includes(`${IMAGE_REPOSITORY}:${DEFAULT_IMAGE_TAG}`));
	assert.match(g.env, /^HETZNER_API_TOKEN=$/m);
	assert.match(g.redirectUri, /^https:\/\/example\.com\/auth\/callback\/tailscale$/);
});

test("domain input is normalised, not echoed as given", () => {
	const g = generate(options("domain", { domain: "https://Example.COM/some/path" }));
	const env = envOf(g.yaml);
	assert.equal(env.get("DOMAIN"), "example.com");
	assert.equal(g.shellUrl, "https://example.com");
});

test("home mode: no sign-in, plain HTTP, one port per grain", () => {
	const g = generate(options("home", { httpPort: "8000" }));
	assert.deepEqual(g.errors, []);
	const env = envOf(g.yaml);
	assert.equal(env.get("HAMSTR_AUTH"), "none");
	assert.equal(env.get("HAMSTR_GRAIN_PORTS"), "20000-20999");
	assert.equal(env.get("TLS_MODE"), undefined);
	assert.deepEqual(portMappings(options("home", { httpPort: "8000" })), [
		"8000:8000",
		"20000-20999:20000-20999",
	]);
	assert.ok(g.warnings.some((w) => w.includes("anyone who can reach")));
});

test("behind a proxy: TLS_MODE=off and the hostnames the proxy routes", () => {
	const g = generate(options("proxy"));
	assert.deepEqual(g.errors, []);
	const env = envOf(g.yaml);
	assert.equal(env.get("TLS_MODE"), "off");
	assert.equal(env.get("HAMSTR_HOST"), "hamstr.example.com");
	assert.equal(env.get("HAMSTR_GRAIN_DOMAIN"), "example.com");
	assert.equal(env.get("HAMSTR_SCHEME"), "https");
	assert.deepEqual(portMappings(options("proxy")), ["8000:8000"]);
});

test("a loopback-only port for a proxy on the same host", () => {
	const g = generate(options("proxy", { httpPort: "8080", bindLoopback: true }));
	assert.deepEqual(portMappings(options("proxy", { httpPort: "8080", bindLoopback: true })), ["127.0.0.1:8080:8000"]);
	assert.match(g.yaml, /127\.0\.0\.1:8080:8000/);
});

test("names mode: a hostname from a names service", () => {
	const g = generate(options("names"));
	assert.deepEqual(g.errors, []);
	const env = envOf(g.yaml);
	assert.equal(env.get("TLS_MODE"), "names");
	assert.equal(env.get("NAME_SERVICE_URL"), "https://names.example.net");
});

test("an install with sign-in needs a provider to be usable", () => {
	const g = generate(options("domain", { oidcEnabled: false }));
	assert.ok(g.errors.some((e) => e.includes("no provider")));
});

test("names mode requires an https names service", () => {
	const g = generate(options("names", { nameServiceUrl: "http://names.example.net" }));
	assert.ok(g.errors.some((e) => e.includes("https://")));
});

test("names mode has no address until the service assigns one", () => {
	const g = generate(options("names"));
	assert.equal(g.shellUrl, "");
	assert.equal(g.redirectUri, "");
});

test("names mode needs a private address to publish", () => {
	const missing = generate(options("names", { addressIpv4: "" }));
	assert.ok(missing.errors.some((e) => e.includes("address to publish")));
	const publicAddress = generate(options("names", { addressIpv4: "203.0.113.10" }));
	assert.ok(publicAddress.errors.some((e) => e.includes("must be private")));
	for (const address of ["10.0.0.4", "192.168.1.20", "172.20.0.3", "100.64.0.10", "fd7a:115c:a1e0::4"]) {
		assert.ok(isPrivateAddress(address), address);
	}
});

test("a bind mount replaces the named volume", () => {
	const g = generate(options("domain", { dataMode: "bind", dataPath: "/srv/hamstr" }));
	assert.match(g.yaml, /\/srv\/hamstr:\/data/);
	assert.equal((g.compose as any).volumes, undefined);
	assert.ok(g.commands[0].includes("mkdir -p /srv/hamstr"));
	assert.ok(g.commands[0].includes("chown 10001:10001"));
});

test("host networking drops every port mapping", () => {
	const g = generate(options("home", { hostNetwork: true, httpPort: "8080" }));
	assert.match(g.yaml, /network_mode: host/);
	assert.equal((g.compose as any).services.hamstr.ports, undefined);
	assert.equal(envOf(g.yaml).get("HTTP_PORT"), "8080");
});

test("Traefik labels replace the published port", () => {
	const g = generate(options("proxy", { traefik: true }));
	assert.deepEqual(g.errors, []);
	const service = (g.compose as any).services.hamstr;
	assert.equal(service.ports, undefined);
	assert.deepEqual(service.networks, ["default", "traefik_web"]);
	assert.equal((g.compose as any).networks.traefik_web.external, true);
	assert.ok(service.labels.some((l: string) => l.includes("Host(`hamstr.example.com`)")));
	assert.ok(service.labels.some((l: string) => l.includes("HostRegexp(`^grain-[a-z0-9]{12}[.]example[.]com$`)")));
	assert.match(g.dockerRun, /--network traefik_web/);
});

test("runtime limits, logging and the restart policy are always there", () => {
	const g = generate(options("domain", { memLimit: "2g", cpus: "1.5" }));
	const service = (g.compose as any).services.hamstr;
	assert.equal(service.mem_limit, "2g");
	assert.equal(service.cpus, "1.5");
	assert.equal(service.restart, "unless-stopped");
	assert.equal(service.init, true);
	assert.equal(service.stop_grace_period, "60s");
	assert.equal(service.logging.driver, "json-file");
	assert.equal(service.logging.options["max-size"], "10m");
});

test("extra environment is merged, duplicates and garbage are handled", () => {
	const g = generate(
		options("domain", {
			extraEnv: "CELLD_LOG=info\nDOMAIN=other.example\nnot a pair\n# comment\nJEV_API_KEY=abc",
		}),
	);
	const env = envOf(g.yaml);
	assert.equal(env.get("CELLD_LOG"), "info");
	assert.equal(env.get("DOMAIN"), "example.com"); // not overwritten
	assert.equal(env.get("JEV_API_KEY"), "abc");
	assert.ok(g.warnings.some((w) => w.includes("not a pair")));
});

test("container names flow into the project, service and volume", () => {
	const g = generate(options("domain", { containerName: "burrow" }));
	assert.equal((g.compose as any).name, "burrow");
	assert.ok((g.compose as any).services.burrow);
	assert.ok((g.compose as any).volumes["burrow-data"]);
	assert.match(g.yaml, /burrow-data:\/data/);
});

test("an uppercase container name is refused (it is the Compose project name)", () => {
	const g = generate(options("domain", { containerName: "Hamstr" }));
	assert.ok(g.errors.some((e) => e.includes("Container name")));
});

test("OIDC provider ids follow the name's lowercase slug", () => {
	assert.equal(providerSlug("Tailscale"), "tailscale");
	assert.equal(providerSlug("My IdP (work)"), "my-idp-work");
	const g = generate(options("domain", { oidcName: "My IdP (work)" }));
	assert.match(g.redirectUri, /\/auth\/callback\/my-idp-work$/);
	assert.equal(redirectUri(options("home")), "");
});

test("secrets never land in the compose file", () => {
	const g = generate(options("domain", { oidcClientSecret: "super-secret-value" }));
	assert.ok(!g.yaml.includes("super-secret-value"));
	assert.ok(g.yaml.includes("${OIDC_CLIENT_SECRET"));
	assert.match(g.env, /^OIDC_CLIENT_SECRET=$/m);
});

test("docker run mirrors the compose file", () => {
	const g = generate(options("domain"));
	assert.match(g.dockerRun, /docker run -d/);
	assert.match(g.dockerRun, /-p 443:8443/);
	assert.match(g.dockerRun, /-p 80:8000/);
	assert.match(g.dockerRun, /--env-file \.env/);
	assert.match(g.dockerRun, /--stop-timeout 60/);
	assert.ok(!g.dockerRun.includes("${CF_DNS_API_TOKEN"));
});

for (const scenario of SCENARIOS) {
	test(`docker compose accepts the ${scenario.id} file`, { skip: hasDocker ? false : "docker is not available" }, () => {
		const opts = options(scenario.id);
		if (scenario.id === "home") opts.httpPort = "8000";
		const result = withDocker(opts);
		assert.ok(result.ok, result.error);
		const service = Object.values(result.parsed.services)[0] as any;
		assert.equal(service.container_name, "hamstr");
		assert.equal(service.restart, "unless-stopped");
		assert.ok(service.volumes.some((v: any) => String(v.target) === "/data"));
	});
}

test("docker compose accepts the Traefik variant", { skip: hasDocker ? false : "docker is not available" }, () => {
	const result = withDocker(options("proxy", { traefik: true }));
	assert.ok(result.ok, result.error);
	const service = Object.values(result.parsed.services)[0] as any;
	assert.equal(service.ports, undefined);
	assert.ok(service.labels["traefik.enable"] === "true");
});

test("docker compose accepts host networking with a bind mount", { skip: hasDocker ? false : "docker is not available" }, () => {
	const result = withDocker(options("home", { hostNetwork: true, dataMode: "bind", dataPath: "/srv/hamstr", user10001: true }));
	assert.ok(result.ok, result.error);
	const service = Object.values(result.parsed.services)[0] as any;
	assert.equal(service.network_mode, "host");
	assert.equal(service.user, "10001:10001");
	assert.equal(service.ports, undefined);
});
