// Reading and validating a packed celld bundle, shared by the store and the CLI.
//
// The bundle is exactly what tools/pack.ts writes and node/push.sh deploys:
//   version           12 hex characters (the router's version id)
//   code.json         { compatibilityDate, source, files: { path: [sha256, type] }, ... }
//   blobs/<sha256>    each file the version serves, named by its own hash
//
// The store never executes it; the installer deploys it into the local celld
// sandbox. Validation here is therefore about *shape and safety*, not intent:
// regular files only, no traversal, bounded size, blob names equal to hashes,
// and every file the code record references is present.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";

export class BundleError extends Error {}

export const BUNDLE_LIMITS = Object.freeze({
	compressed: 32 * 1024 * 1024,
	uncompressed: 80 * 1024 * 1024,
	file: 20 * 1024 * 1024, // the router's per-asset limit
	code: 16 * 1024 * 1024, // the router's code limit
	codeRecord: 4 * 1024 * 1024,
	metadata: 64 * 1024,
	entries: 5000,
	// Raw tar bytes after gunzip, headers and PAX/GNU metadata included. The
	// file-content limit alone is not enough: tar metadata is decompressed too.
	raw: 96 * 1024 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[a-f0-9]{12}$/;
const fail = (msg: string): never => {
	throw new BundleError(msg);
};
type Limits = typeof BUNDLE_LIMITS;
const limitsFor = (over?: Partial<Limits>): Limits => ({ ...BUNDLE_LIMITS, ...(over ?? {}) });

/** Strip the "./" prefix and trailing slash GNU tar adds for `tar -C dir -cf - .`. */
function cleanName(raw: unknown): string {
	let name = String(raw ?? "");
	while (name.startsWith("./")) name = name.slice(2);
	while (name.endsWith("/")) name = name.slice(0, -1);
	if (name === "" || name === ".") return "";
	if (name.length > 400) fail("an archive path is longer than 400 characters");
	if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) fail(`unsafe archive path: ${JSON.stringify(name)}`);
	if (name.split("/").some((p) => p === "" || p === "." || p === "..")) fail(`unsafe archive path: ${JSON.stringify(name)}`);
	return name;
}

function safeRelativePath(path: unknown): boolean {
	if (typeof path !== "string" || !path || path.length > 400) return false;
	if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
	return !path.split("/").some((p) => p === "" || p === "." || p === "..");
}

const isMetadataType = (type: string): boolean => type === "pax-header" || type === "pax-global-header" || type === "gnu-long-path" || type === "gnu-long-link-path";

/** Read a file entry into a Buffer, enforcing the per-file and total limits. */
// tar-stream's entry stream: a Readable with resume()/destroy(), not a node:stream Readable.
function readEntry(stream: any, max: number, totalLeft: number): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks = [];
		let size = 0;
		stream.on("data", (chunk) => {
			size += chunk.length;
			if (size > max) {
				reject(new BundleError(`an archive entry is larger than ${Math.floor(max / 1024 / 1024)} MiB`));
				stream.destroy();
				return;
			}
			if (size > totalLeft) {
				reject(new BundleError(`the unpacked bundle is larger than ${Math.floor(limitsFor().uncompressed / 1024 / 1024)} MiB`));
				stream.destroy();
				return;
			}
			chunks.push(chunk);
		});
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

/**
 * Validate a .tgz packed bundle.
 *
 * @param {string} file path to the gzip-compressed tar
 * @param {object} [options]
 * @param {string} [options.extractTo] directory to also unpack the verified files into
 * @param {object} [options.limits] overrides for tests
 * @param {boolean} [options.keepBlobs] also return every blob's bytes, by hash (the moderation site reads them)
 * @returns {Promise<{version: string, files: number, bytes: number, code: object, blobs?: Map<string, Buffer>}>}
 */
export async function readBundle(
	file: string,
	{ extractTo, limits: over, keepBlobs = false }: { extractTo?: string; limits?: Partial<Limits>; keepBlobs?: boolean } = {},
): Promise<{ version: string; files: number; bytes: number; code: any; blobs?: Map<string, Buffer> }> {
	const limits = limitsFor(over);
	const stat = statSync(file);
	if (!stat.isFile()) fail("bundle is not a file");
	if (stat.size > limits.compressed) fail(`bundle is larger than ${Math.floor(limits.compressed / 1024 / 1024)} MiB`);

	const files = new Map<string, { buffer: Buffer; sha: string }>(); // normalized path -> { buffer, sha }
	let version: string | null = null;
	let code: any = null;
	let entries = 0;
	let bytes = 0;
	const seen = new Set<string>();
	const dest = extractTo ? resolve(extractTo) : null;

	const write = (name: string, buffer: Buffer) => {
		if (!dest) return;
		const target = resolve(join(dest, name));
		if (target !== dest && !target.startsWith(dest + sep)) fail(`archive path escapes the bundle: ${name}`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, buffer, { flag: "wx", mode: 0o644 }); // never overwrite / follow a link
	};

	await new Promise<void>((resolvePromise, rejectPromise) => {
		let settled = false;
		const finish = (err?: unknown) => {
			if (settled) return;
			settled = true;
			if (err) rejectPromise(err);
			else resolvePromise();
		};
		const parser = extract();
		let rawBytes = 0;
		const counter = new Transform({
			transform(chunk, _encoding, callback) {
				rawBytes += chunk.length;
				if (rawBytes > limits.raw) {
					callback(new BundleError(`the unpacked tar stream is larger than ${Math.floor(limits.raw / 1024 / 1024)} MiB`));
					return;
				}
				callback(null, chunk);
			},
		});
		counter.on("error", (err) => finish(err));

		parser.on("entry", (header, stream, next) => {
			(async () => {
				entries++;
				if (entries > limits.entries) fail(`an archive has more than ${limits.entries} entries`);
				if (isMetadataType(header.type)) {
					// PAX/GNU metadata is decompressed too, so it must count against
					// the unpacked budget; otherwise a tiny archive can inflate to
					// gigabytes while only reporting a few KB of file content.
					const meta = await readEntry(stream, limits.metadata, limits.uncompressed - bytes);
					bytes += meta.length;
					return;
				}
				const name = cleanName(header.name);
				if (name === "") {
					stream.resume();
					return;
				}
				if (header.type === "directory") {
					if (name !== "blobs") fail(`unexpected directory in bundle: ${name}`);
					stream.resume();
					return;
				}
				if (header.type !== "file") fail(`bundle contains a ${header.type || "special"} entry (${name}); only regular files and directories are allowed`);
				if (seen.has(name)) fail(`duplicate archive entry: ${name}`);
				seen.add(name);

				const isBlob = name.startsWith("blobs/");
				if (name !== "version" && name !== "code.json" && !isBlob) fail(`unexpected file in bundle: ${name}`);
				if (isBlob && !SHA256.test(name.slice("blobs/".length))) fail(`bad blob name: ${name}`);
				const max = name === "version" ? 64 : name === "code.json" ? limits.codeRecord : limits.file;
				const buffer = await readEntry(stream, max, limits.uncompressed - bytes);
				bytes += buffer.length;
				if (header.size !== undefined && header.size !== buffer.length) fail(`archive entry ${name} is truncated`);

				const digest = createHash("sha256").update(buffer).digest("hex");
				files.set(name, { buffer, sha: digest });
				if (isBlob && digest !== name.slice("blobs/".length)) {
					fail(`blob ${name.slice("blobs/".length, "blobs/".length + 12)}… does not match its content hash`);
				}
				write(name, buffer);
			})()
				.then(() => next())
				.catch((err) => {
					parser.destroy();
					finish(err);
					stream.resume();
				});
		});
		parser.on("finish", () => finish());
		parser.on("error", (err) => finish(new BundleError(`not a valid tar.gz bundle: ${err.message}`)));
		const gunzip = createGunzip();
		gunzip.on("error", (err) => finish(new BundleError(`not a valid gzip file: ${err.message}`)));
		createReadStream(file)
			.on("error", finish)
			.pipe(gunzip)
			.pipe(counter)
			.pipe(parser);
	});

	const versionFile = files.get("version");
	if (!versionFile) fail("bundle has no version file");
	const text = versionFile.buffer.toString("utf8").trim();
	if (!VERSION.test(text)) fail("bundle version must be 12 lowercase hex characters");
	version = text;

	const codeFile = files.get("code.json");
	if (!codeFile) fail("bundle has no code.json");
	try {
		code = JSON.parse(codeFile.buffer.toString("utf8"));
	} catch {
		fail("code.json is not valid JSON");
	}
	if (!code || typeof code !== "object" || Array.isArray(code)) fail("code.json must be an object");
	if (typeof code.compatibilityDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(code.compatibilityDate)) {
		fail("code.json compatibilityDate must be YYYY-MM-DD");
	}
	if (typeof code.source !== "string") fail("code.json source must be a string");
	if (Buffer.byteLength(code.source, "utf8") > limits.code) fail(`server code is larger than ${Math.floor(limits.code / 1024 / 1024)} MiB`);
	if (!code.files || typeof code.files !== "object" || Array.isArray(code.files)) fail("code.json files must be an object");
	const codeFiles = Object.entries(code.files);
	if (codeFiles.length > limits.entries) fail(`code.json lists more than ${limits.entries} files`);
	const referenced = new Set<string>();
	for (const [path, value] of codeFiles) {
		if (!safeRelativePath(path)) fail(`unsafe file path in code.json: ${JSON.stringify(path)}`);
		if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !SHA256.test(value[0])) {
			fail(`bad file entry in code.json: ${path}`);
		}
		if (typeof value[1] !== "string" || value[1].length > 200 || /[\r\n]/.test(value[1])) fail(`bad content type in code.json: ${path}`);
		referenced.add(value[0]);
	}
	const blobs = new Map([...files].filter(([name]) => name.startsWith("blobs/")).map(([name, f]) => [name.slice(6), f]));
	for (const hash of referenced) if (!blobs.has(hash)) fail(`code.json references a missing blob: ${hash.slice(0, 12)}…`);
	for (const hash of blobs.keys()) if (!referenced.has(hash)) fail(`bundle contains an unreferenced blob: ${hash.slice(0, 12)}…`);

	return { version, files: codeFiles.length, bytes, code, ...(keepBlobs && { blobs: new Map([...blobs].map(([hash, f]) => [hash, f.buffer])) }) };
}
