// What the zone answers. For an install with id k3x9 in zone hamstr.app:
//
//   k3x9.hamstr.app                   A/AAAA  the install's address
//   *.k3x9.hamstr.app                 A/AAAA  the same (any depth)
//   _acme-challenge.k3x9.hamstr.app   TXT     its published challenge values
//
// plus the zone's own SOA and NS records and a few fixed records from the
// config (the name servers' addresses, the API's hostname).
import { RCODE, TYPE } from "./dns.mjs";

export function createZone({ zone, nameservers, hostmaster, records, ttl, store }) {
	const soa = () => ({
		name: zone,
		type: TYPE.SOA,
		ttl,
		data: {
			mname: nameservers[0],
			rname: hostmaster,
			serial: Math.floor(Date.now() / 1000),
			refresh: 3600,
			retry: 600,
			expire: 604800,
			minimum: ttl,
		},
	});
	const nodata = () => ({ rcode: RCODE.NOERROR, answers: [], authority: [soa()] });
	const nxdomain = () => ({ rcode: RCODE.NXDOMAIN, answers: [], authority: [soa()] });
	const suffix = `.${zone}`;

	return function lookup(name, type) {
		if (name !== zone && !name.endsWith(suffix)) return { rcode: RCODE.REFUSED };
		const rel = name === zone ? "@" : name.slice(0, -suffix.length);

		if (rel === "@") {
			if (type === TYPE.SOA) return { rcode: RCODE.NOERROR, answers: [{ ...soa(), name: null }] };
			if (type === TYPE.NS)
				return { rcode: RCODE.NOERROR, answers: nameservers.map((ns) => ({ name: null, type, ttl, data: ns })) };
		}

		const fixed = records.filter((r) => r.name === rel);
		if (fixed.length) {
			const answers = fixed.filter((r) => r.type === type).map((r) => ({ name: null, type, ttl, data: r.value }));
			return answers.length ? { rcode: RCODE.NOERROR, answers } : nodata();
		}
		if (rel === "@") return nodata();

		const labels = rel.split(".");
		const install = store.get(labels.at(-1));
		if (!install) return nxdomain();

		if (labels.length === 2 && labels[0] === "_acme-challenge") {
			if (type !== TYPE.TXT) return nodata();
			const values = store.challenges(install.id);
			return values.length
				? { rcode: RCODE.NOERROR, answers: values.map((data) => ({ name: null, type, ttl, data })) }
				: nodata();
		}

		const address = type === TYPE.A ? install.ipv4 : type === TYPE.AAAA ? install.ipv6 : null;
		return address ? { rcode: RCODE.NOERROR, answers: [{ name: null, type, ttl, data: address }] } : nodata();
	};
}
