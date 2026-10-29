// Address parsing for A/AAAA records, and the "private only" rule: an install
// may only point its name at an address nobody on the internet can reach, so
// the zone can never be used to host something public.
import { isIPv4, isIPv6 } from "node:net";

export function ipv4Bytes(ip) {
	if (!isIPv4(ip)) throw new Error(`not an IPv4 address: ${ip}`);
	return Buffer.from(ip.split(".").map(Number));
}

export function ipv6Bytes(ip) {
	if (!isIPv6(ip) || ip.includes("%")) throw new Error(`not an IPv6 address: ${ip}`);
	let text = ip;
	// An embedded IPv4 tail (::ffff:10.0.0.1) becomes two hex groups.
	const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (tail) {
		const b = ipv4Bytes(tail[1]);
		text = text.slice(0, -tail[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
	}
	const [head, rest] = text.split("::");
	const left = head ? head.split(":") : [];
	const right = rest === undefined ? [] : rest ? rest.split(":") : [];
	const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	const out = Buffer.alloc(16);
	groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
	return out;
}

// [network, prefix length]
const PRIVATE_V4 = [
	[0x0a000000, 8], // 10.0.0.0/8
	[0xac100000, 12], // 172.16.0.0/12
	[0xc0a80000, 16], // 192.168.0.0/16
	[0x64400000, 10], // 100.64.0.0/10, the CGNAT range Tailscale addresses come from
];

export function isPrivateIPv4(ip) {
	if (!isIPv4(ip)) return false;
	const n = ipv4Bytes(ip).readUInt32BE(0);
	return PRIVATE_V4.some(([net, bits]) => n >>> (32 - bits) === net >>> (32 - bits));
}

// fc00::/7: unique local addresses, which includes Tailscale's fd7a:115c:a1e0::/48.
export function isPrivateIPv6(ip) {
	if (!isIPv6(ip)) return false;
	return (ipv6Bytes(ip)[0] & 0xfe) === 0xfc;
}
