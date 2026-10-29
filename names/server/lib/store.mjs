// SQLite state: registered installs (token stored only as a hash) and the
// ACME challenge values they have published. Nothing else is kept.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Lowercase letters and digits without the ones that are easy to misread.
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LENGTH = 6;

const sha256 = (text) => createHash("sha256").update(text).digest();

// reserved: names in the zone that are not installs (ns1, the API host, …).
export function openStore(path, { reserved = [] } = {}) {
	const taken = new Set(reserved);
	const db = new DatabaseSync(path);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS installs (
			id TEXT PRIMARY KEY,
			token_hash BLOB NOT NULL,
			ipv4 TEXT,
			ipv6 TEXT,
			created INTEGER NOT NULL,
			last_seen INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS challenges (
			id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
			value TEXT NOT NULL,
			expires INTEGER NOT NULL,
			PRIMARY KEY (id, value)
		);
		PRAGMA foreign_keys = ON;
	`);

	const q = {
		insert: db.prepare("INSERT INTO installs (id, token_hash, created, last_seen) VALUES (?, ?, ?, ?)"),
		get: db.prepare("SELECT id, token_hash, ipv4, ipv6, created, last_seen FROM installs WHERE id = ?"),
		touch: db.prepare("UPDATE installs SET last_seen = ? WHERE id = ?"),
		address: db.prepare("UPDATE installs SET ipv4 = ?, ipv6 = ?, last_seen = ? WHERE id = ?"),
		remove: db.prepare("DELETE FROM installs WHERE id = ?"),
		challenges: db.prepare("SELECT value FROM challenges WHERE id = ? AND expires > ? ORDER BY value"),
		countChallenges: db.prepare("SELECT count(*) AS n FROM challenges WHERE id = ? AND expires > ?"),
		addChallenge: db.prepare("INSERT OR REPLACE INTO challenges (id, value, expires) VALUES (?, ?, ?)"),
		removeChallenge: db.prepare("DELETE FROM challenges WHERE id = ? AND value = ?"),
		pruneChallenges: db.prepare("DELETE FROM challenges WHERE expires <= ?"),
		pruneInstalls: db.prepare("DELETE FROM installs WHERE last_seen < ?"),
	};

	const now = () => Math.floor(Date.now() / 1000);

	return {
		// Returns { id, token }. The token is shown once and is "<id>.<secret>",
		// so it identifies its install on its own.
		register() {
			for (let attempt = 0; attempt < 10; attempt++) {
				const bytes = randomBytes(ID_LENGTH);
				const id = [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
				if (taken.has(id)) continue;
				const token = `${id}.${randomBytes(32).toString("base64url")}`;
				try {
					q.insert.run(id, sha256(token), now(), now());
					return { id, token };
				} catch (err) {
					if (!String(err.message).includes("UNIQUE")) throw err;
				}
			}
			throw new Error("could not find a free id");
		},

		// The install a token belongs to, or null.
		authenticate(token) {
			const id = typeof token === "string" ? token.split(".")[0] : "";
			const row = id && q.get.get(id);
			if (!row) return null;
			const given = sha256(token);
			if (!timingSafeEqual(given, Buffer.from(row.token_hash))) return null;
			q.touch.run(now(), id);
			return row;
		},

		get: (id) => q.get.get(id) ?? null,
		setAddress: (id, ipv4, ipv6) => q.address.run(ipv4, ipv6, now(), id),
		remove: (id) => q.remove.run(id),

		challenges: (id) => q.challenges.all(id, now()).map((r) => r.value),
		challengeCount: (id) => q.countChallenges.get(id, now()).n,
		addChallenge: (id, value, ttl) => q.addChallenge.run(id, value, now() + ttl),
		removeChallenge: (id, value) => q.removeChallenge.run(id, value),

		// Drops expired challenges and installs not seen for maxAgeDays.
		prune(maxAgeDays) {
			q.pruneChallenges.run(now());
			return Number(q.pruneInstalls.run(now() - maxAgeDays * 86400).changes);
		},

		close: () => db.close(),
	};
}
