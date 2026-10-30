// A minimal authoritative DNS server: one question per message, the record
// types the zone needs (A, AAAA, TXT, NS, SOA), over UDP and TCP. What to
// answer is decided by a lookup function; this file only speaks the wire
// format (RFC 1035).
//
// The question is echoed byte for byte, and answers for the queried name point
// back at it, so a resolver that randomizes letter case (DNS 0x20) gets back
// exactly what it sent.
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { ipv4Bytes, ipv6Bytes } from "./ip.ts";

export const TYPE = { A: 1, NS: 2, SOA: 6, TXT: 16, AAAA: 28 };
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
const CLASS_IN = 1;
const UDP_MAX = 512;

// Returns { id, flags, name, type, qclass, questionEnd } or null if the
// message is too broken to answer at all.
export function parseQuery(msg) {
	if (msg.length < 12) return null;
	const id = msg.readUInt16BE(0);
	const flags = msg.readUInt16BE(2);
	const qdcount = msg.readUInt16BE(4);
	if (flags & 0x8000) return null; // a response, not a query
	if (qdcount !== 1) return { id, flags, error: RCODE.FORMERR };
	const labels = [];
	let at = 12;
	for (;;) {
		if (at >= msg.length) return { id, flags, error: RCODE.FORMERR };
		const len = msg[at];
		if (len === 0) break;
		if (len > 63) return { id, flags, error: RCODE.FORMERR }; // no compression in questions
		labels.push(msg.subarray(at + 1, at + 1 + len).toString("latin1"));
		at += 1 + len;
	}
	at += 1;
	if (at + 4 > msg.length) return { id, flags, error: RCODE.FORMERR };
	return {
		id,
		flags,
		name: labels.join(".").toLowerCase(),
		type: msg.readUInt16BE(at),
		qclass: msg.readUInt16BE(at + 2),
		questionEnd: at + 4,
	};
}

function encodeName(name) {
	const parts = name ? name.split(".") : [];
	const bufs = parts.map((label) => {
		const b = Buffer.from(label, "latin1");
		if (b.length < 1 || b.length > 63) throw new Error(`bad label in ${name}`);
		return Buffer.concat([Buffer.from([b.length]), b]);
	});
	return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeRdata(type, data) {
	switch (type) {
		case TYPE.A:
			return ipv4Bytes(data);
		case TYPE.AAAA:
			return ipv6Bytes(data);
		case TYPE.NS:
			return encodeName(data);
		case TYPE.TXT: {
			const text = Buffer.from(data, "utf8");
			const chunks = [];
			for (let i = 0; i < text.length || i === 0; i += 255) {
				const part = text.subarray(i, i + 255);
				chunks.push(Buffer.from([part.length]), part);
			}
			return Buffer.concat(chunks);
		}
		case TYPE.SOA: {
			const nums = Buffer.alloc(20);
			[data.serial, data.refresh, data.retry, data.expire, data.minimum].forEach((n, i) => nums.writeUInt32BE(n >>> 0, i * 4));
			return Buffer.concat([encodeName(data.mname), encodeName(data.rname), nums]);
		}
		default:
			throw new Error(`unsupported record type ${type}`);
	}
}

// A record whose name is null is for the queried name and points at the question.
function encodeRecord(record) {
	const owner = record.name == null ? Buffer.from([0xc0, 12]) : encodeName(record.name);
	const rdata = encodeRdata(record.type, record.data);
	const fixed = Buffer.alloc(10);
	fixed.writeUInt16BE(record.type, 0);
	fixed.writeUInt16BE(CLASS_IN, 2);
	fixed.writeUInt32BE(record.ttl, 4);
	fixed.writeUInt16BE(rdata.length, 8);
	return Buffer.concat([owner, fixed, rdata]);
}

export function buildResponse(msg, query, result, maxSize = Infinity) {
	const opcode = (query.flags >> 11) & 0xf;
	const rd = query.flags & 0x0100;
	const header = Buffer.alloc(12);
	header.writeUInt16BE(query.id, 0);
	const question = query.questionEnd ? msg.subarray(12, query.questionEnd) : Buffer.alloc(0);
	header.writeUInt16BE(question.length ? 1 : 0, 4);
	const answers = (result.answers ?? []).map(encodeRecord);
	const authority = (result.authority ?? []).map(encodeRecord);
	let flags = 0x8000 | (opcode << 11) | 0x0400 | rd | (result.rcode & 0xf); // QR, AA
	let body = Buffer.concat([question, ...answers, ...authority]);
	if (12 + body.length > maxSize) {
		flags |= 0x0200; // TC: the client retries over TCP
		body = question;
	} else {
		header.writeUInt16BE(answers.length, 6);
		header.writeUInt16BE(authority.length, 8);
	}
	header.writeUInt16BE(flags, 2);
	return Buffer.concat([header, body]);
}

export function answer(msg, lookup, maxSize) {
	const query = parseQuery(msg);
	if (!query) return null;
	let result;
	if (query.error !== undefined) result = { rcode: query.error };
	else if (((query.flags >> 11) & 0xf) !== 0) result = { rcode: RCODE.NOTIMP };
	else if (query.qclass !== CLASS_IN) result = { rcode: RCODE.REFUSED };
	else {
		try {
			result = lookup(query.name, query.type);
		} catch (err) {
			console.error(`dns: lookup ${query.name} failed: ${err.message}`);
			result = { rcode: RCODE.SERVFAIL };
		}
	}
	return buildResponse(msg, query, result, maxSize);
}

// Starts UDP and TCP listeners on the same port. Resolves once both listen.
export async function startDnsServer({ host, port, lookup }) {
	const udp = createSocket(host.includes(":") ? "udp6" : "udp4");
	udp.on("message", (msg, rinfo) => {
		const res = answer(msg, lookup, UDP_MAX);
		if (res) udp.send(res, rinfo.port, rinfo.address);
	});
	udp.on("error", (err) => console.error(`dns: udp: ${err.message}`));

	const tcp = createServer((sock) => {
		sock.setTimeout(10_000, () => sock.destroy());
		sock.on("error", () => {});
		let buf = Buffer.alloc(0);
		sock.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length > 70_000) return sock.destroy();
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
				buf = buf.subarray(2 + msg.length);
				const res = answer(msg, lookup, 65535);
				if (!res) return sock.destroy();
				const len = Buffer.alloc(2);
				len.writeUInt16BE(res.length);
				sock.write(Buffer.concat([len, res]));
			}
		});
	});

	await new Promise<void>((ok, fail) => {
		udp.once("error", fail);
		udp.bind(port, host, () => ok());
	});
	const udpPort = udp.address().port;
	await new Promise<void>((ok, fail) => {
		tcp.once("error", fail);
		tcp.listen(udpPort, host, () => ok());
	});
	return {
		port: udpPort,
		close: () => Promise.all([new Promise<void>((ok) => udp.close(() => ok())), new Promise<void>((ok) => tcp.close(() => ok()))]),
	};
}
