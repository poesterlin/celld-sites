// An app file (.hamstr): one app, ready to add to a Hamstr without the store.
// `hamstr pack` writes it; Hamstr's "Add from file" reads it.
//
// It is a plain (uncompressed) tar with exactly two regular files, in order:
//   hamstr.json   the manifest, as published to the store
//   bundle.tgz    the packed bundle, exactly what the store would serve
//
// Reading checks the container first (names, types, sizes), then the manifest
// with validateManifest and the bundle with readBundle, the same checks as a
// store upload. Nothing in it is built or run here.
import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extract, pack } from "tar-stream";
import { BUNDLE_LIMITS, BundleError, readBundle } from "./bundle.ts";
import { ManifestError, parseManifest } from "./manifest.ts";

export const APP_FILE_EXTENSION = ".hamstr";
const MANIFEST_MAX = 64 * 1024;
const ENTRIES = ["hamstr.json", "bundle.tgz"];
// The two files plus tar headers and padding.
export const APP_FILE_MAX = BUNDLE_LIMITS.compressed + MANIFEST_MAX + 16 * 1024;

export class AppFileError extends Error {}
const fail = (message) => {
	throw new AppFileError(message);
};

/** The bytes of an app file for a manifest (object) and a bundle (tar.gz Buffer). */
export async function writeAppFile(manifest: Record<string, unknown>, bundle: Buffer): Promise<Buffer> {
	const json = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`);
	const packer = pack();
	const chunks: Buffer[] = [];
	packer.on("data", (chunk: Buffer) => chunks.push(chunk));
	const ended = new Promise<void>((resolvePromise, rejectPromise) => {
		packer.on("end", () => resolvePromise());
		packer.on("error", rejectPromise);
	});
	packer.entry({ name: "hamstr.json", size: json.length, mode: 0o644, mtime: new Date(0) }, json);
	packer.entry({ name: "bundle.tgz", size: bundle.length, mode: 0o644, mtime: new Date(0) }, bundle);
	packer.finalize();
	await ended;
	return Buffer.concat(chunks);
}

/**
 * Read and check an app file. The bundle is written to `<dir>/bundle.tgz`.
 * Resolves { manifest, bundlePath, bundleSha256, bundleSize }; throws
 * AppFileError (bad container), ManifestError or BundleError.
 */
export async function readAppFile(file: string, dir: string) {
	const size = statSync(file).size;
	if (size > APP_FILE_MAX) fail(`an app file can be at most ${Math.floor(APP_FILE_MAX / 1024 / 1024)} MiB`);

	const bundlePath = join(dir, "bundle.tgz");
	let manifestText: string | null = null;
	let bundleSha256: string | null = null;
	let bundleSize = 0;
	const seen: string[] = [];

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const ex = extract();
		ex.on("entry", (header, stream, next) => {
			const name = header.name.replace(/^\.\//, "");
			const expected = ENTRIES[seen.length];
			if (header.type !== "file" || name !== expected) {
				stream.resume();
				return rejectPromise(new AppFileError(`not an app file: expected ${expected ?? "nothing more"}, found ${header.type} ${JSON.stringify(name)}`));
			}
			seen.push(name);
			const limit = name === "hamstr.json" ? MANIFEST_MAX : BUNDLE_LIMITS.compressed;
			if (header.size > limit) {
				stream.resume();
				return rejectPromise(new AppFileError(`${name} is too large`));
			}
			const chunks: Buffer[] = [];
			const hash = createHash("sha256");
			stream.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
				hash.update(chunk);
			});
			stream.on("error", rejectPromise);
			stream.on("end", () => {
				const data = Buffer.concat(chunks);
				if (name === "hamstr.json") manifestText = data.toString("utf8");
				else {
					writeFileSync(bundlePath, data, { mode: 0o600 });
					bundleSha256 = hash.digest("hex");
					bundleSize = data.length;
				}
				next();
			});
		});
		ex.on("finish", () => resolvePromise());
		ex.on("error", (err) => rejectPromise(new AppFileError(`not an app file: ${err.message}`)));
		const input = createReadStream(file);
		input.on("error", rejectPromise);
		input.pipe(ex);
	});

	if (seen.length !== ENTRIES.length) fail("not an app file: it needs hamstr.json and bundle.tgz");
	const manifest = parseManifest(manifestText);
	await readBundle(bundlePath);
	return { manifest, bundlePath, bundleSha256, bundleSize };
}

export { BundleError, ManifestError };
