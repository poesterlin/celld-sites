// Home Assistant add-on options (/data/options.json) → the appliance's
// environment variables, printed as shell `export` lines for run.sh.
import { readFileSync } from "node:fs";

const options = JSON.parse(readFileSync(process.argv[2], "utf8"));
const map = {
	auth: "HAMSTR_AUTH",
	tls_mode: "TLS_MODE",
	domain: "DOMAIN",
	dns_provider: "DNS_PROVIDER",
	name_service_url: "NAME_SERVICE_URL",
	address: "ADDRESS_IPV4",
	acme_email: "ACME_EMAIL",
	hamstr_host: "HAMSTR_HOST",
	grain_domain: "HAMSTR_GRAIN_DOMAIN",
	oidc_name: "OIDC_NAME",
	oidc_issuer: "OIDC_ISSUER",
	oidc_client_id: "OIDC_CLIENT_ID",
	oidc_client_secret: "OIDC_CLIENT_SECRET",
	store: "HAMSTR_STORE",
};
const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const out = [];
for (const [key, name] of Object.entries(map)) {
	const value = options[key];
	if (value !== undefined && value !== null && value !== "") out.push(`export ${name}=${quote(value)}`);
}
// "NAME=value" entries: the DNS provider's credentials (`lego dnshelp`) and
// anything else the appliance reads.
for (const entry of options.env ?? []) {
	const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/s.exec(entry);
	if (!m) {
		console.error(`ha-options: ignoring env entry that is not NAME=value`);
		continue;
	}
	out.push(`export ${m[1]}=${quote(m[2])}`);
}
if (options.store && !options.store_public) out.push(`export HAMSTR_STORE_PUBLIC=${quote(options.store)}`);
console.log(out.join("\n"));
