// Backup files in and out of the shell API.
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./core.js";
import { requireSameOrigin } from "./http.js";

/** Save an uploaded backup (the raw file as the body) to a temp file. The
 *  caller releases it. Same-origin only, and never a form post: a form cannot
 *  send application/octet-stream. */
export async function saveBackupUpload(event) {
	const c = event.locals.core;
	requireSameOrigin(event);
	if (!String(event.request.headers.get("content-type") ?? "").startsWith("application/octet-stream")) {
		throw new HttpError(415, "send the backup file as application/octet-stream");
	}
	const declared = Number(event.request.headers.get("content-length"));
	if (declared > c.MAX_BACKUP_BYTES) throw new HttpError(413, "that backup is too large");
	if (!event.request.body) throw new HttpError(400, "send a backup file");
	const file = c.tempFile("upload");
	let size = 0;
	const limit = new Transform({
		transform(chunk, _enc, done) {
			size += chunk.length;
			done(size > c.MAX_BACKUP_BYTES ? new HttpError(413, "that backup is too large") : null, chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(event.request.body), limit, createWriteStream(file, { mode: 0o600 }));
	} catch (err) {
		c.releaseTemp(file);
		throw err instanceof HttpError ? err : new HttpError(400, "the upload did not finish");
	}
	if (!size) {
		c.releaseTemp(file);
		throw new HttpError(400, "the backup file is empty");
	}
	return file;
}

/** Send a temp file as a download, then release it. */
export function sendBackup(c, file, name) {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;"\\]/g, "_");
	const stream = createReadStream(file);
	stream.on("close", () => c.releaseTemp(file));
	return new Response(Readable.toWeb(stream), {
		status: 200,
		headers: {
			"content-type": "application/octet-stream",
			"content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		},
	});
}

/** "Office party 2026-10-30.hamstr-backup" */
export function backupName(c, title) {
	const day = new Date().toISOString().slice(0, 10);
	const base = `${title} ${day}`.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-").slice(0, 120);
	return `${base}.${c.BACKUP_EXTENSION}`;
}
