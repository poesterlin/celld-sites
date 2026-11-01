// The compose.yaml generator behind /install/generator.
//
// Pure functions, no DOM: the Vue component only collects options and renders
// the result, and .vitepress/theme/lib/compose.test.ts checks every scenario
// against `docker compose config`.
//
// The generated stack runs the appliance image (appliance/Dockerfile): celld,
// Hamstr, the S3 store and Caddy in one container. See appliance/README.md for
// the settings this maps to.

export type Scenario = "home" | "domain" | "proxy" | "names";

export interface DnsProvider {
	id: string;
	label: string;
	/** lego's variable names, checked against lego v5.6.0 (`lego dnshelp`). */
	vars: string[];
	/** Docs slug on go-acme.github.io/lego. */
	docs?: string;
}

export interface Options {
	scenario: Scenario;
	containerName: string;
	imageSource: "registry" | "build";
	imageTag: string;
	dataMode: "volume" | "bind";
	dataPath: string;
	hostNetwork: boolean;
	bindLoopback: boolean;
	httpPort: string;
	httpsPort: string;
	domain: string;
	dnsProvider: string;
	acmeEmail: string;
	nameServiceUrl: string;
	addressIpv4: string;
	proxyHost: string;
	proxyGrainDomain: string;
	proxyHttps: boolean;
	grainPorts: string;
	oidcEnabled: boolean;
	oidcName: string;
	oidcIssuer: string;
	oidcClientId: string;
	oidcClientSecret: string;
	storeUrl: string;
	memLimit: string;
	cpus: string;
	timezone: string;
	traefik: boolean;
	watchtower: boolean;
	user10001: boolean;
	extraEnv: string;
}

export interface Generated {
	compose: Record<string, unknown>;
	yaml: string;
	env: string;
	dockerRun: string;
	/** Problems that make the configuration unusable. */
	errors: string[];
	/** Things that are valid but need the operator's attention. */
	warnings: string[];
	/** Where the shell will be reachable. */
	shellUrl: string;
	/** Redirect URI for the first OIDC client. */
	redirectUri: string;
	/** The commands to run after saving the files. */
	commands: string[];
}

export const DNS_PROVIDERS: DnsProvider[] = [
	{ id: "cloudflare", label: "Cloudflare", vars: ["CF_DNS_API_TOKEN"], docs: "cloudflare" },
	{ id: "hetzner", label: "Hetzner", vars: ["HETZNER_API_TOKEN"], docs: "hetzner" },
	{ id: "digitalocean", label: "DigitalOcean", vars: ["DO_AUTH_TOKEN"], docs: "digitalocean" },
	{
		id: "route53",
		label: "Amazon Route 53",
		vars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
		docs: "route53",
	},
	{
		id: "namecheap",
		label: "Namecheap",
		vars: ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY"],
		docs: "namecheap",
	},
	{ id: "gandi", label: "Gandi", vars: ["GANDI_API_KEY"], docs: "gandi" },
	{
		id: "porkbun",
		label: "Porkbun",
		vars: ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"],
		docs: "porkbun",
	},
	{ id: "duckdns", label: "Duck DNS", vars: ["DUCKDNS_TOKEN"], docs: "duckdns" },
	{
		id: "ovh",
		label: "OVH",
		vars: ["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY"],
		docs: "ovh",
	},
	{ id: "ionos", label: "IONOS", vars: ["IONOS_API_KEY"], docs: "ionos" },
	{
		id: "netcup",
		label: "Netcup",
		vars: ["NETCUP_CUSTOMER_NUMBER", "NETCUP_API_KEY", "NETCUP_API_PASSWORD"],
		docs: "netcup",
	},
	{ id: "desec", label: "deSEC", vars: ["DESEC_TOKEN"], docs: "desec" },
	{ id: "godaddy", label: "GoDaddy", vars: ["GODADDY_API_KEY", "GODADDY_API_SECRET"], docs: "godaddy" },
	{ id: "inwx", label: "INWX", vars: ["INWX_USERNAME", "INWX_PASSWORD"], docs: "inwx" },
	{ id: "linode", label: "Linode", vars: ["LINODE_TOKEN"], docs: "linode" },
	{ id: "vultr", label: "Vultr", vars: ["VULTR_API_KEY"], docs: "vultr" },
	{
		id: "scaleway",
		label: "Scaleway",
		vars: ["SCW_ACCESS_KEY", "SCW_SECRET_KEY", "SCW_PROJECT_ID"],
		docs: "scaleway",
	},
	{ id: "acme-dns", label: "acme-dns", vars: ["ACME_DNS_API_BASE", "ACME_DNS_STORAGE_PATH"], docs: "acme-dns" },
	{ id: "other", label: "Other (any lego provider)", vars: [] },
];

export const IMAGE_REPOSITORY = "ghcr.io/poesterlin/celld-sites-appliance";
export const DEFAULT_IMAGE_TAG = "0.3.2";
export const DEFAULT_GRAIN_PORTS = "20000-20999";

export const SCENARIOS: { id: Scenario; label: string; blurb: string }[] = [
	{
		id: "home",
		label: "Home network",
		blurb: "No sign-in. Plain HTTP.",
	},
	{
		id: "domain",
		label: "My own domain",
		blurb: "Real HTTPS with a certificate.",
	},
	{
		id: "proxy",
		label: "Behind my proxy",
		blurb: "You already run Caddy, nginx or Traefik.",
	},
	{
		id: "names",
		label: "A names service",
		blurb: "You get a hostname from a service.",
	},
];

function envNameService(): string {
	// Vite replaces `import.meta.env.VITE_*` at build time; Node has no
	// `import.meta.env`, hence the typeof guard.
	if (typeof import.meta.env === "undefined") return "";
	const value = import.meta.env.VITE_NAMES_SERVICE_URL;
	return typeof value === "string" ? value.trim() : "";
}

export function defaultOptions(): Options {
	return {
		scenario: "home",
		containerName: "hamstr",
		imageSource: "registry",
		imageTag: DEFAULT_IMAGE_TAG,
		dataMode: "volume",
		dataPath: "/srv/hamstr",
		hostNetwork: false,
		bindLoopback: false,
		httpPort: "8000",
		httpsPort: "443",
		domain: "example.com",
		dnsProvider: "cloudflare",
		acmeEmail: "",
		nameServiceUrl: envNameService(),
		addressIpv4: "",
		proxyHost: "hamstr.example.com",
		proxyGrainDomain: "example.com",
		proxyHttps: true,
		grainPorts: DEFAULT_GRAIN_PORTS,
		oidcEnabled: false,
		oidcName: "Tailscale",
		oidcIssuer: "",
		oidcClientId: "",
		oidcClientSecret: "",
		storeUrl: "https://store.hamstr.app",
		memLimit: "",
		cpus: "",
		timezone: "",
		traefik: false,
		watchtower: false,
		user10001: false,
		extraEnv: "",
	};
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PORT = /^\d{1,5}$/;

/** The names service only accepts private / CGNAT / ULA addresses. */
export function isPrivateAddress(value: string): boolean {
	const v = value.trim();
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^f[cd][0-9a-f]{2}:/i.test(v)) return true;
	return false;
}

export function isHostname(value: string): boolean {
	return HOSTNAME.test(value.trim());
}

function validPort(value: string): boolean {
	if (!PORT.test(value.trim())) return false;
	const n = Number(value);
	return n > 0 && n < 65536;
}

function normaliseHost(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
		.replace(/\/.*$/, "")
		.replace(/^\*\./, "");
}

function providerOf(id: string): DnsProvider {
	return DNS_PROVIDERS.find((p) => p.id === id) ?? DNS_PROVIDERS[0];
}

function isHome(o: Options): boolean {
	return o.scenario === "home";
}

function needsTls(o: Options): boolean {
	return o.scenario === "domain" || o.scenario === "names";
}

export function shellHost(o: Options): string {
	if (o.scenario === "proxy") return normaliseHost(o.proxyHost);
	if (o.scenario === "names") return "";
	return normaliseHost(o.domain);
}

export function shellUrl(o: Options): string {
	if (isHome(o)) return `http://<this computer>:${o.httpPort}`;
	if (o.scenario === "names") return "";
	const scheme = o.scenario === "proxy" ? (o.proxyHttps ? "https" : "http") : "https";
	return `${scheme}://${shellHost(o) || "<host>"}`;
}

export function providerSlug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "provider"
	);
}

export function redirectUri(o: Options): string {
	if (isHome(o) || !o.oidcEnabled) return "";
	const base = shellUrl(o);
	if (!base) return "";
	return `${base}/auth/callback/${providerSlug(o.oidcName)}`;
}

/** Parse the `KEY=value` textarea into entries, ignoring blanks and comments. */
export function parseExtraEnv(text: string): { entries: [string, string][]; bad: string[] } {
	const entries: [string, string][] = [];
	const bad: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
		if (!match) {
			bad.push(line);
			continue;
		}
		entries.push([match[1], match[2]]);
	}
	return { entries, bad };
}

export function validate(o: Options): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.containerName.trim())) {
		errors.push("Container name must be lowercase letters, digits, dashes and underscores (it is also the Compose project name).");
	}

	if (!validPort(o.httpPort)) errors.push(`HTTP port “${o.httpPort}” is not a port number.`);
	if (!o.hostNetwork && o.scenario !== "proxy" && !validPort(o.httpsPort)) {
		errors.push(`HTTPS port “${o.httpsPort}” is not a port number.`);
	}
	if (!o.hostNetwork && o.httpPort === o.httpsPort && o.scenario !== "proxy") {
		errors.push("HTTP and HTTPS cannot use the same host port.");
	}
	if (isHome(o) && !/^\d{4,5}-\d{4,5}$/.test(o.grainPorts.trim())) {
		errors.push("Grain ports must be a range like 20000-20999.");
	}

	if (o.scenario === "domain") {
		const domain = normaliseHost(o.domain);
		if (!isHostname(domain)) errors.push("Enter the domain as a hostname, for example example.com (no scheme, no path).");
		if (o.dnsProvider === "other") {
			warnings.push("For an unlisted DNS provider, add the provider's lego variables under Extra environment.");
		}
		if (o.acmeEmail.trim() && !EMAIL.test(o.acmeEmail.trim())) {
			warnings.push("The ACME email does not look like an address; Let's Encrypt ignores an invalid one.");
		}
		if (domain.split(".").length < 2) warnings.push("A single-label domain cannot get a public certificate.");
	}

	if (o.scenario === "names") {
		const url = o.nameServiceUrl.trim();
		if (!url) errors.push("Set the names service URL (NAME_SERVICE_URL).");
		else if (!/^https:\/\//.test(url)) errors.push("The names service URL must use https://.");

		const address = o.addressIpv4.trim();
		if (!address) {
			errors.push(
				"Set the address to publish: this computer's Tailscale or LAN address. A normal Docker network hides it from the container.",
			);
		} else if (!isPrivateAddress(address)) {
			errors.push("The address to publish must be private (LAN, Tailscale or another private range), not a public address.");
		}
	}

	if (o.scenario === "proxy") {
		if (!isHostname(normaliseHost(o.proxyHost))) errors.push("Set the shell hostname your proxy will answer on.");
		if (!isHostname(normaliseHost(o.proxyGrainDomain))) {
			errors.push("Set the domain grains live under; grains are grain-<id>.<that domain>.");
		}
		warnings.push(
			"The proxy must route the shell hostname and *.grain domain to this container's HTTP port, and terminate TLS itself.",
		);
		if (o.traefik && !o.proxyHttps) warnings.push("With Traefik labels on, TLS termination usually means HAMSTR_SCHEME=https.");
	}

	if (o.hostNetwork && o.scenario !== "home") {
		warnings.push("Host networking is meant for home mode: other containers then share these ports.");
	}

	if (isHome(o)) {
		warnings.push("Home mode has no sign-in: anyone who can reach this port is the owner. Use it on a network you trust.");
		warnings.push("Browsers treat plain HTTP as insecure, so passkeys, the clipboard, the camera and installing apps to a home screen do not work.");
	}

	if (o.dataMode === "bind" && !o.dataPath.trim().startsWith("/")) {
		errors.push("A bind mount needs an absolute path, for example /srv/hamstr.");
	}

	if (o.scenario === "domain" && !o.hostNetwork) {
		warnings.push(`Point both the A/AAAA record for ${normaliseHost(o.domain) || "your domain"} and its wildcard * to this host, and allow ${o.httpPort} and ${o.httpsPort} in.`);
	}

	if (o.oidcEnabled && !isHome(o)) {
		if (!o.oidcIssuer.trim()) errors.push("Set the OIDC issuer (it must be an HTTPS address).");
		else if (!/^https:\/\//.test(o.oidcIssuer.trim())) errors.push("The OIDC issuer must use https://.");
		if (!o.oidcClientId.trim()) errors.push("Set the OIDC client id once the client is registered at your provider.");
	}

	if (!o.oidcEnabled && !isHome(o)) {
		errors.push("A fresh install with sign-in has no provider: nobody could open it. Turn sign-in on and set the provider.");
	}

	if (o.oidcEnabled && isHome(o)) {
		warnings.push("Home mode ignores the OIDC settings; remove them or switch to a scenario with sign-in.");
	}

	const extra = parseExtraEnv(o.extraEnv);
	for (const line of extra.bad) warnings.push(`Ignored extra environment line “${line}” (use NAME=value).`);

	if (o.storeUrl.trim() && !/^https?:\/\//.test(o.storeUrl.trim())) {
		errors.push("The store URL must start with http:// or https://.");
	}

	if (o.memLimit.trim() && !/^\d+(\.\d+)?[bkmg]?$/i.test(o.memLimit.trim())) {
		errors.push("Memory limit looks wrong; use a value like 512m or 2g.");
	}
	if (o.cpus.trim() && !/^\d+(\.\d+)?$/.test(o.cpus.trim())) {
		errors.push("CPU limit must be a number, for example 2 or 1.5.");
	}

	return { errors, warnings };
}

/* ------------------------------------------------------------------ */
/* generation                                                          */
/* ------------------------------------------------------------------ */

export function generate(o: Options): Generated {
	const { errors, warnings } = validate(o);
	const compose: Record<string, unknown> = {
		name: o.containerName.trim(),
		services: {},
	};
	const services = compose.services as Record<string, unknown>;
	const service: Record<string, unknown> = {};
	services[o.containerName.trim()] = service;

	service.restart = "unless-stopped";
	service.init = true;
	service.container_name = o.containerName.trim();
	service.stop_grace_period = "60s";

	if (o.imageSource === "build") {
		service.build = { context: ".", dockerfile: "appliance/Dockerfile" };
		service.image = `${o.containerName.trim()}:local`;
	} else {
		service.image = `${IMAGE_REPOSITORY}:${o.imageTag.trim() || DEFAULT_IMAGE_TAG}`;
	}

	// environment, in a readable order
	const env: [string, string][] = [];
	const secrets: [string, string][] = [];

	if (o.hostNetwork) service.network_mode = "host";

	if (o.scenario === "domain") {
		const domain = normaliseHost(o.domain);
		const provider = providerOf(o.dnsProvider);
		env.push(["TLS_MODE", "domain"]);
		env.push(["DOMAIN", domain]);
		env.push(["DNS_PROVIDER", provider.id]);
		for (const name of provider.vars) {
			secrets.push([name, "${" + name + ":?set " + name + " in .env}"]);
		}
		if (o.acmeEmail.trim()) env.push(["ACME_EMAIL", o.acmeEmail.trim()]);
	} else if (o.scenario === "names") {
		env.push(["TLS_MODE", "names"]);
		env.push(["NAME_SERVICE_URL", o.nameServiceUrl.trim()]);
		if (o.addressIpv4.trim()) env.push(["ADDRESS_IPV4", o.addressIpv4.trim()]);
	} else if (o.scenario === "proxy") {
		env.push(["TLS_MODE", "off"]);
		env.push(["HAMSTR_HOST", normaliseHost(o.proxyHost)]);
		env.push(["HAMSTR_GRAIN_DOMAIN", normaliseHost(o.proxyGrainDomain)]);
		env.push(["HAMSTR_SCHEME", o.proxyHttps ? "https" : "http"]);
	} else {
		env.push(["HAMSTR_AUTH", "none"]);
		env.push(["HAMSTR_GRAIN_PORTS", o.grainPorts.trim()]);
		if (o.hostNetwork) env.push(["HTTP_PORT", o.httpPort.trim()]);
	}

	if (o.oidcEnabled && !isHome(o)) {
		env.push(["OIDC_NAME", o.oidcName.trim() || "Sign in"]);
		env.push(["OIDC_ISSUER", o.oidcIssuer.trim()]);
		env.push(["OIDC_CLIENT_ID", o.oidcClientId.trim()]);
		secrets.push(["OIDC_CLIENT_SECRET", "${OIDC_CLIENT_SECRET:-}"]);
	}

	if (o.storeUrl.trim()) env.push(["HAMSTR_STORE", o.storeUrl.trim()]);
	if (o.timezone.trim()) env.push(["TZ", o.timezone.trim()]);

	for (const [key, value] of parseExtraEnv(o.extraEnv).entries) {
		if (!env.some(([k]) => k === key) && !secrets.some(([k]) => k === key)) env.push([key, value]);
	}

	if (env.length || secrets.length) {
		service.environment = [...env, ...secrets].map(([key, value]) => `${key}=${value}`);
	}

	// data
	service.volumes = [o.dataMode === "bind" ? `${o.dataPath.trim()}:/data` : `${o.containerName.trim()}-data:/data`];
	if (o.dataMode === "volume") {
		compose.volumes = { [`${o.containerName.trim()}-data`]: {} };
	}

	// ports
	if (!o.hostNetwork) {
		service.ports = portMappings(o);
	} else {
		warnings.push("Host networking: the shell answers on HTTP_PORT and grains on their own ports; no ports are mapped.");
	}

	// limits and runtime
	if (o.memLimit.trim()) service.mem_limit = o.memLimit.trim();
	if (o.cpus.trim()) service.cpus = o.cpus.trim();
	service.security_opt = ["no-new-privileges:true"];
	if (o.user10001) service.user = "10001:10001";
	service.logging = { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };

	// labels
	const labels: string[] = [];
	if (o.watchtower) labels.push("com.centurylinklabs.watchtower.enable=true");
	if (o.traefik) {
		if (o.scenario !== "proxy" || o.hostNetwork) {
			warnings.push("Traefik labels need the “behind my own proxy” scenario without host networking; the port mapping stays.");
		} else {
			labels.push(...traefikLabels(o));
			service.networks = ["default", "traefik_web"];
			delete service.ports;
			const networks = (compose.networks as Record<string, unknown>) ?? {};
			networks.traefik_web = { external: true };
			compose.networks = networks;
		}
	}
	if (labels.length) service.labels = labels;

	const yaml = toYaml(compose);

	// .env: only what must not live in the compose file
	const envLines: string[] = [];
	if (secrets.length) {
		envLines.push("# Secrets for the Hamstr appliance. Keep this file private:", "#   chmod 600 .env", "");
		if (o.scenario === "domain" && providerOf(o.dnsProvider).vars.length) {
			envLines.push(`# ${providerOf(o.dnsProvider).label}: an API token that may edit DNS records.`);
		}
		if (o.oidcEnabled && !isHome(o)) {
			envLines.push("# The OIDC client secret. The first provider is seeded only when this is set.");
		}
		envLines.push("");
		for (const [key] of secrets) envLines.push(`${key}=`);
	}
	const envFile = envLines.join("\n").trimEnd() + (envLines.length ? "\n" : "");

	const dockerRun = dockerRunCommand(o, [...env, ...secrets]);

	return {
		compose,
		yaml,
		env: envFile,
		dockerRun,
		errors,
		warnings,
		shellUrl: shellUrl(o),
		redirectUri: redirectUri(o),
		commands: commands(o, secrets.length > 0),
	};
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Host:container port mappings, shared by the compose file and `docker run`. */
export function portMappings(o: Options): string[] {
	const loopback = o.bindLoopback && o.scenario !== "domain" && o.scenario !== "names" ? "127.0.0.1:" : "";
	if (o.scenario === "home") {
		return [`${loopback}${o.httpPort}:8000`, `${o.grainPorts.trim()}:${o.grainPorts.trim()}`];
	}
	if (o.scenario === "proxy") return [`${loopback}${o.httpPort}:8000`];
	return [`${o.httpsPort}:8443`, `${o.httpPort}:8000`];
}

function dockerRunCommand(o: Options, env: [string, string][]): string {
	const name = o.containerName.trim();
	const image = o.imageSource === "build" ? `${name}:local` : `${IMAGE_REPOSITORY}:${o.imageTag.trim() || DEFAULT_IMAGE_TAG}`;
	const args = ["docker run -d", `--name ${shellQuote(name)}`, "--init", "--restart unless-stopped", "--stop-timeout 60"];
	if (o.hostNetwork) args.push("--network host");
	if (o.dataMode === "bind") args.push(`-v ${shellQuote(`${o.dataPath.trim()}:/data`)}`);
	else args.push(`-v ${shellQuote(`${name}-data:/data`)}`);

	if (o.traefik && o.scenario === "proxy" && !o.hostNetwork) {
		args.push("--network traefik_web");
		for (const label of traefikLabels(o)) args.push(`--label ${shellQuote(label)}`);
	} else if (!o.hostNetwork) {
		for (const mapping of portMappings(o)) args.push(`-p ${shellQuote(mapping)}`);
	}

	if (o.memLimit.trim()) args.push(`--memory ${shellQuote(o.memLimit.trim())}`);
	if (o.cpus.trim()) args.push(`--cpus ${shellQuote(o.cpus.trim())}`);
	if (o.user10001) args.push("--user 10001:10001");
	if (o.watchtower) args.push("--label com.centurylinklabs.watchtower.enable=true");
	if (env.length) args.push("--env-file .env");
	for (const [key, value] of env) {
		if (value.startsWith("${")) continue; // comes from .env
		args.push(`-e ${shellQuote(`${key}=${value}`)}`);
	}
	args.push(shellQuote(image));
	return args.join(" \\\n  ");
}

export function traefikLabels(o: Options): string[] {
	const host = normaliseHost(o.proxyHost);
	const grain = normaliseHost(o.proxyGrainDomain).replace(/\./g, "[.]");
	const router = o.containerName.trim();
	return [
		"traefik.enable=true",
		"traefik.docker.network=traefik_web",
		`traefik.http.routers.${router}.rule=Host(\`${host}\`) || HostRegexp(\`^grain-[a-z0-9]{12}[.]${grain}$\`)`,
		`traefik.http.routers.${router}.ruleSyntax=v3`,
		`traefik.http.routers.${router}.priority=20`,
		`traefik.http.services.${router}.loadbalancer.server.port=8000`,
	];
}

function commands(o: Options, hasEnvFile: boolean): string[] {
	const name = o.containerName.trim();
	const lines: string[] = [];
	if (o.dataMode === "bind") {
		lines.push(`sudo mkdir -p ${shellQuote(o.dataPath.trim())} && sudo chown 10001:10001 ${shellQuote(o.dataPath.trim())}`);
	}
	if (hasEnvFile) lines.push("chmod 600 .env");
	lines.push("docker compose up -d");
	lines.push(`docker compose logs -f --tail=100 ${name}`);
	return lines;
}

/* ------------------------------------------------------------------ */
/* a small YAML writer                                                 */
/* ------------------------------------------------------------------ */

const PLAIN = /^[A-Za-z0-9_./@-]+$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function scalar(value: unknown): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	const text = String(value);
	if (text !== "" && PLAIN.test(text) && !RESERVED.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) return text;
	// ${VAR:?...} is fine inside double quotes; compose interpolates first.
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emit(value: unknown, indent: number): string {
	const pad = "  ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]`;
		return value
			.map((item) => {
				if (item && typeof item === "object") {
					const body = emit(item, indent + 1).replace(/^\s+/, "");
					return `${pad}- ${body}`;
				}
				return `${pad}- ${scalar(item)}`;
			})
			.join("\n");
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return `${pad}{}`;
		return entries
			.map(([key, child]) => {
				if (child && typeof child === "object" && !Array.isArray(child)) {
					if (Object.keys(child as object).length === 0) return `${pad}${key}: {}`;
					const body = emit(child, indent + 1);
					return `${pad}${key}:\n${body}`;
				}
				if (Array.isArray(child)) {
					if (child.length === 0) return `${pad}${key}: []`;
					return `${pad}${key}:\n${emit(child, indent + 1)}`;
				}
				return `${pad}${key}: ${scalar(child)}`;
			})
			.join("\n");
	}
	return `${pad}${scalar(value)}`;
}

/** Serialise the compose object in a stable, `docker compose` friendly form. */
export function toYaml(compose: Record<string, unknown>): string {
	const header = [
		"# Hamstr, in one container: celld, Hamstr, the S3 store and Caddy.",
		"# Generated at /install/generator; see the docs for what each setting does.",
		"# The first start creates the platform's secrets in /data/secrets.env.",
		"",
	];
	return header.join("\n") + emit(compose, 0) + "\n";
}
