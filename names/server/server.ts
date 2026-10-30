// Hamstr names: gives each install a hostname <id>.<zone> with a wildcard
// below it, pointing at the install's private or Tailscale address, and lets
// the install publish ACME DNS-01 challenges for that name so it can get its
// own wildcard certificate. The service never sees certificates or keys.
//
// One process: an HTTP API (lib/api.ts) and the zone's authoritative DNS
// server (lib/dns.ts, lib/zone.ts), sharing one SQLite file.
import { createServer } from "node:http";
import { createApi } from "./lib/api.ts";
import { loadConfig } from "./lib/config.ts";
import { startDnsServer } from "./lib/dns.ts";
import { openStore } from "./lib/store.ts";
import { createZone } from "./lib/zone.ts";

export async function start(config) {
	const store = openStore(config.dbPath, { reserved: config.reserved });
	const dns = await startDnsServer({ host: config.dnsHost, port: config.dnsPort, lookup: createZone({ ...config, store }) });

	const http = createServer(createApi({ config, store }));
	http.requestTimeout = 15_000;
	http.headersTimeout = 10_000;
	await new Promise<void>((ok, fail) => {
		http.once("error", fail);
		http.listen(config.httpPort, config.httpHost, () => ok());
	});

	const prune = () => {
		const removed = store.prune(config.expireDays);
		if (removed) console.log(`names: released ${removed} install(s) not seen for ${config.expireDays} days`);
	};
	prune();
	const timer = setInterval(prune, 3_600_000);
	timer.unref();

	return {
		dnsPort: dns.port,
		httpPort: (http.address() as import("node:net").AddressInfo).port,
		store,
		async close() {
			clearInterval(timer);
			await Promise.all([dns.close(), new Promise((ok) => http.close(ok))]);
			store.close();
		},
	};
}

if (import.meta.main) {
	const config = loadConfig();
	const running = await start(config);
	console.log(`names: zone ${config.zone}, DNS on ${config.dnsHost}:${running.dnsPort}, API on ${config.httpHost}:${running.httpPort}`);
	for (const signal of ["SIGTERM", "SIGINT"])
		process.on(signal, () => running.close().then(() => process.exit(0)));
}
