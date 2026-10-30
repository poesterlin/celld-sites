// Configuration from the environment; see .env.example for what each value means.
import { isIPv4, isIPv6 } from "node:net";
import { TYPE } from "./dns.ts";

const bool = (v, fallback) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v));
const int = (v, fallback) => {
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) throw new Error(`expected a whole number, got "${v}"`);
	return n;
};
const fqdn = (name) => name.toLowerCase().replace(/\.$/, "");

// "ns1 A 203.0.113.1, names A 203.0.113.1, @ AAAA 2001:db8::1"
function parseRecords(text, zone) {
	if (!text?.trim()) return [];
	return text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
		const [name, type, value, ...extra] = entry.split(/\s+/);
		const t = type?.toUpperCase();
		if (extra.length || !value) throw new Error(`RECORDS: expected "name TYPE value", got "${entry}"`);
		if (t === "A" && !isIPv4(value)) throw new Error(`RECORDS: ${value} is not IPv4`);
		if (t === "AAAA" && !isIPv6(value)) throw new Error(`RECORDS: ${value} is not IPv6`);
		if (!["A", "AAAA", "TXT"].includes(t)) throw new Error(`RECORDS: type ${type} is not supported (A, AAAA, TXT)`);
		let rel = fqdn(name);
		if (rel === zone) rel = "@";
		else if (rel.endsWith(`.${zone}`)) rel = rel.slice(0, -zone.length - 1);
		return { name: rel, type: TYPE[t], value };
	});
}

export function loadConfig(env = process.env) {
	if (!env.ZONE) throw new Error("ZONE is required, e.g. ZONE=hamstr.app");
	const zone = fqdn(env.ZONE);
	const nameservers = (env.NAMESERVERS || `ns1.${zone}`).split(",").map((s) => fqdn(s.trim())).filter(Boolean);
	const records = parseRecords(env.RECORDS, zone);
	return {
		zone,
		nameservers,
		hostmaster: fqdn(env.HOSTMASTER || `hostmaster.${zone}`),
		records,
		// The first label of every fixed record cannot be handed out as an install id.
		reserved: [...new Set(records.map((r) => r.name.split(".").at(-1)))],
		ttl: int(env.TTL, 60),
		httpHost: env.HTTP_HOST || "0.0.0.0",
		httpPort: int(env.HTTP_PORT, 8080),
		dnsHost: env.DNS_HOST || "0.0.0.0",
		dnsPort: int(env.DNS_PORT, 5353),
		dbPath: env.DB_PATH || "/data/names.db",
		trustProxy: bool(env.TRUST_PROXY, false),
		allowPublicAddresses: bool(env.ALLOW_PUBLIC_ADDRESSES, false),
		registerPerHour: int(env.REGISTER_PER_HOUR, 10),
		expireDays: int(env.EXPIRE_DAYS, 90),
		challengeTtl: int(env.CHALLENGE_TTL, 3600),
		maxChallenges: int(env.MAX_CHALLENGES, 4),
	};
}
