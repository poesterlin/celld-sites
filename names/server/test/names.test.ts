import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { isPrivateIPv4, isPrivateIPv6, ipv6Bytes } from "../lib/ip.ts";
import { start } from "../server.ts";

const dir = mkdtempSync(join(tmpdir(), "names-test-"));
let running, resolver, api;

before(async () => {
	running = await start(
		loadConfig({
			ZONE: "Hamstr.Test.",
			RECORDS: "ns1 A 192.0.2.53, names A 192.0.2.80, @ TXT hello",
			HTTP_HOST: "127.0.0.1",
			HTTP_PORT: "0",
			DNS_HOST: "127.0.0.1",
			DNS_PORT: "0",
			DB_PATH: join(dir, "names.db"),
			REGISTER_PER_HOUR: "3",
		}),
	);
	resolver = new Resolver({ timeout: 2000, tries: 1 });
	resolver.setServers([`127.0.0.1:${running.dnsPort}`]);
	api = (method: string, path: string, { token, basic, body }: { token?: string; basic?: string; body?: unknown } = {}) =>
		fetch(`http://127.0.0.1:${running.httpPort}${path}`, {
			method,
			headers: {
				...(token && { authorization: `Bearer ${token}` }),
				...(basic && { authorization: `Basic ${Buffer.from(basic).toString("base64")}` }),
				...(body && { "content-type": "application/json" }),
			},
			body: body && JSON.stringify(body),
		});
});

after(async () => {
	await running.close();
	rmSync(dir, { recursive: true, force: true });
});

const dnsCode = (promise) => promise.then(() => "ok", (err) => err.code);

describe("ip", () => {
	test("private ranges", () => {
		for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255"])
			assert.ok(isPrivateIPv4(ip), ip);
		for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "11.0.0.1"])
			assert.ok(!isPrivateIPv4(ip), ip);
		assert.ok(isPrivateIPv6("fd7a:115c:a1e0::1"));
		assert.ok(isPrivateIPv6("fc00::1"));
		assert.ok(!isPrivateIPv6("2001:db8::1"));
		assert.ok(!isPrivateIPv6("::ffff:10.0.0.1"));
	});

	test("ipv6 bytes", () => {
		assert.equal(ipv6Bytes("::1").toString("hex"), "0".repeat(31) + "1");
		assert.equal(ipv6Bytes("fd7a:115c:a1e0::1").toString("hex"), "fd7a115ca1e0" + "0".repeat(19) + "1");
		assert.equal(ipv6Bytes("::ffff:10.0.0.1").toString("hex"), "0".repeat(20) + "ffff0a000001");
	});
});

describe("zone records", () => {
	test("SOA, NS and fixed records", async () => {
		const soa = await resolver.resolveSoa("hamstr.test");
		assert.equal(soa.nsname, "ns1.hamstr.test");
		assert.equal(soa.hostmaster, "hostmaster.hamstr.test");
		assert.deepEqual(await resolver.resolveNs("hamstr.test"), ["ns1.hamstr.test"]);
		assert.deepEqual(await resolver.resolve4("ns1.hamstr.test"), ["192.0.2.53"]);
		assert.deepEqual(await resolver.resolve4("NAMES.hamstr.TEST"), ["192.0.2.80"]);
		assert.deepEqual(await resolver.resolveTxt("hamstr.test"), [["hello"]]);
		assert.equal(await dnsCode(resolver.resolve4("hamstr.test")), "ENODATA");
	});

	test("unknown names and other zones", async () => {
		assert.equal(await dnsCode(resolver.resolve4("nobody.hamstr.test")), "ENOTFOUND");
		assert.equal(await dnsCode(resolver.resolve4("grain-1.nobody.hamstr.test")), "ENOTFOUND");
		assert.equal(await dnsCode(resolver.resolve4("example.com")), "EREFUSED");
	});
});

describe("install lifecycle", () => {
	let install;

	test("register", async () => {
		const res = await api("POST", "/v1/register");
		assert.equal(res.status, 201);
		install = await res.json();
		assert.match(install.id, /^[a-z2-9]{6}$/);
		assert.equal(install.hostname, `${install.id}.hamstr.test`);
		assert.ok(install.token.startsWith(`${install.id}.`));
		// Registered but no address yet: the name exists, without records.
		assert.equal(await dnsCode(resolver.resolve4(install.hostname)), "ENODATA");
	});

	test("auth is required and checked", async () => {
		assert.equal((await api("GET", "/v1/install")).status, 401);
		assert.equal((await api("GET", "/v1/install", { token: `${install.id}.wrong` })).status, 401);
		assert.equal((await api("GET", "/v1/install", { token: "zzzzzz.nope" })).status, 401);
		// Basic auth with someone else's id as user name is refused.
		assert.equal((await api("GET", "/v1/install", { basic: `other:${install.token}` })).status, 401);
		const res = await api("GET", "/v1/install", { basic: `${install.id}:${install.token}` });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).hostname, install.hostname);
	});

	test("address: private only, then served for the name and every name below it", async () => {
		const set = (body) => api("PUT", "/v1/address", { token: install.token, body });
		assert.equal((await set({ ipv4: "8.8.8.8" })).status, 422);
		assert.equal((await set({ ipv6: "2001:db8::1" })).status, 422);
		assert.equal((await set({ ipv4: "nonsense" })).status, 400);
		assert.equal((await set({})).status, 400);
		const res = await set({ ipv4: "100.82.130.136", ipv6: "fd7a:115c:a1e0::1" });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).ipv4, "100.82.130.136");

		for (const name of [install.hostname, `grain-abc.${install.hostname}`, `a.b.${install.hostname}`]) {
			assert.deepEqual(await resolver.resolve4(name), ["100.82.130.136"], name);
			assert.deepEqual(await resolver.resolve6(name), ["fd7a:115c:a1e0::1"], name);
		}
		assert.equal(await dnsCode(resolver.resolveTxt(install.hostname)), "ENODATA");
	});

	test("challenges, the way lego's httpreq provider sends them", async () => {
		const fqdn = `_acme-challenge.${install.hostname}.`;
		const basic = `${install.id}:${install.token}`;
		const a = "A".repeat(43);
		const b = "b_-".repeat(14) + "x";
		for (const value of [a, b]) assert.equal((await api("POST", "/v1/present", { basic, body: { fqdn, value } })).status, 200);
		const txt = (await resolver.resolveTxt(fqdn.slice(0, -1))).map((r) => r.join("")).sort();
		assert.deepEqual(txt, [a, b].sort());
		// The challenge name has no address records.
		assert.equal(await dnsCode(resolver.resolve4(fqdn.slice(0, -1))), "ENODATA");

		await api("POST", "/v1/cleanup", { basic, body: { fqdn, value: a } });
		assert.deepEqual(await resolver.resolveTxt(fqdn.slice(0, -1)), [[b]]);
		await api("POST", "/v1/cleanup", { basic, body: { fqdn, value: b } });
		assert.equal(await dnsCode(resolver.resolveTxt(fqdn.slice(0, -1))), "ENODATA");
	});

	test("a token can only publish its own challenge name", async () => {
		const other = await (await api("POST", "/v1/register")).json();
		const present = (fqdn, value = "x".repeat(43)) => api("POST", "/v1/present", { token: install.token, body: { fqdn, value } });
		assert.equal((await present(`_acme-challenge.${other.hostname}.`)).status, 403);
		assert.equal((await present(`_acme-challenge.sub.${install.hostname}.`)).status, 403);
		assert.equal((await present("_acme-challenge.hamstr.test.")).status, 403);
		assert.equal((await present(`_acme-challenge.${install.hostname}.`, "has spaces")).status, 400);
		assert.equal((await present(`_acme-challenge.${install.hostname}.`, "\"quoted\"")).status, 400);
		// At most four values at once.
		for (let i = 0; i < 4; i++) assert.equal((await present(`_acme-challenge.${install.hostname}`, `v${i}`)).status, 200);
		assert.equal((await present(`_acme-challenge.${install.hostname}`, "v4")).status, 429);
		assert.equal((await present(`_acme-challenge.${install.hostname}`, "v0")).status, 200); // re-publishing is fine
		for (let i = 0; i < 4; i++)
			await api("POST", "/v1/cleanup", { token: install.token, body: { fqdn: `_acme-challenge.${install.hostname}`, value: `v${i}` } });
	});

	test("registration is rate limited", async () => {
		// Two registrations so far, the limit is three per hour.
		assert.equal((await api("POST", "/v1/register")).status, 201);
		assert.equal((await api("POST", "/v1/register")).status, 429);
	});

	test("release", async () => {
		assert.equal((await api("DELETE", "/v1/install", { token: install.token })).status, 204);
		assert.equal((await api("GET", "/v1/install", { token: install.token })).status, 401);
		assert.equal(await dnsCode(resolver.resolve4(install.hostname)), "ENOTFOUND");
	});
});

describe("wire format", () => {
	// One raw TCP query, with mixed case, to check the TCP framing and that the
	// question comes back exactly as sent (DNS 0x20).
	test("TCP, and the question is echoed as sent", async () => {
		const qname = "NS1.HaMsTr.TeSt";
		const labels = qname.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
		const query = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])]);
		const framed = Buffer.concat([Buffer.from([0, query.length]), query]);
		const res = await new Promise<Buffer>((ok, fail) => {
			const sock = connect(running.dnsPort, "127.0.0.1", () => sock.write(framed));
			let buf = Buffer.alloc(0);
			sock.on("data", (d: Buffer) => {
				buf = Buffer.concat([buf, d]);
				if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
					sock.end();
					ok(buf.subarray(2));
				}
			});
			sock.on("error", fail);
		});
		assert.equal(res.readUInt16BE(0), 0x1234);
		const flags = res.readUInt16BE(2);
		assert.ok(flags & 0x8000, "QR");
		assert.ok(flags & 0x0400, "AA");
		assert.equal(flags & 0xf, 0);
		assert.equal(res.readUInt16BE(6), 1);
		assert.ok(res.subarray(12).includes(Buffer.from("HaMsTr")));
		assert.deepEqual([...res.subarray(-4)], [192, 0, 2, 53]);
	});
});
