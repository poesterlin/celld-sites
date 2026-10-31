import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const id = (bytes = 12) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Provider secrets are stored encrypted; the key is derived from AUTH_KEY, so a
 *  copy of the database alone does not reveal them. */
export function vault(secret: string) {
	const key = createHash("sha256").update(`celld-auth/providers/${secret}`).digest();
	return {
		seal(value: unknown): string {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
		},
		open(sealed: string): any {
			if (!sealed) return {};
			const raw = Buffer.from(sealed, "base64url");
			const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
			decipher.setAuthTag(raw.subarray(12, 28));
			return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
		},
	};
}
