// State changes the store and the moderation site share. Both write the same
// tables, so a release is published, rejected or removed by exactly one piece
// of code, whoever asks for it.
//
// Neither function here touches bundle files: the store deletes the files of a
// removed release itself and sweeps the rest (blobs no live release uses), so
// the moderation site can mount the blobs read-only.
import type { Sql } from "./db.ts";

/** Rejected bundles stay this long, so a moderator can reverse the decision. */
export const REJECTED_KEEP_DAYS = 30;

export async function logEvent(sql: Sql, actor: string, action: string, target: string, note: string | null = null): Promise<void> {
	await sql.query("INSERT INTO events (at, actor, action, target, note) VALUES (now(), $1, $2, $3, $4)", [actor, action, target, note]);
}

export async function setTags(sql: Sql, appId: number, tags: string[]): Promise<void> {
	await sql.query("DELETE FROM app_tags WHERE app_id = $1", [appId]);
	for (const tag of new Set(tags)) await sql.query("INSERT INTO app_tags (tag, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [tag, appId]);
}

/** Puts a release in the catalog. Its manifest becomes the app's listing (name,
 *  summary, icon, tags, …) only now: a release waiting for review never changes
 *  what the catalog shows. `review` records who approved it. */
export async function publishRelease(sql: Sql, releaseId: number, review?: { by: string; note?: string | null }): Promise<boolean> {
	const row = await sql.one(
		`UPDATE releases SET status = 'published', published_at = now(),
			reviewed_at = CASE WHEN $2::text IS NULL THEN reviewed_at ELSE now() END,
			reviewed_by = COALESCE($2::text, reviewed_by),
			review_note = CASE WHEN $2::text IS NULL THEN review_note ELSE $3::text END
		 WHERE id = $1 AND bundle_sha IS NOT NULL AND status IN ('pending', 'rejected')
		 RETURNING app_id, manifest`,
		[releaseId, review?.by ?? null, review?.note ?? null],
	);
	if (!row) return false;
	const m = row.manifest;
	await sql.query(
		"UPDATE apps SET name = $1, summary = $2, description = $3, homepage = $4, source = $5, license = $6, icon = $7, category = $8, tags = $9::jsonb, updated_at = now() WHERE id = $10",
		[m.name, m.summary, m.description ?? "", m.homepage ?? null, m.source ?? null, m.license, m.icon ?? "", m.category ?? null, JSON.stringify(m.tags ?? []), row.app_id],
	);
	await setTags(sql, row.app_id, m.tags ?? []);
	return true;
}

/** Takes a release out of the catalog (or keeps it out) with a reason the
 *  publisher sees. The bundle stays for REJECTED_KEEP_DAYS, then the store's
 *  sweep deletes it. The version stays taken. */
export async function rejectRelease(sql: Sql, releaseId: number, { by, note }: { by: string; note: string }): Promise<boolean> {
	const changed = await sql.run(
		"UPDATE releases SET status = 'rejected', reviewed_at = now(), reviewed_by = $2, review_note = $3 WHERE id = $1 AND status IN ('pending', 'published', 'yanked')",
		[releaseId, by, note],
	);
	if (changed) await sql.query("UPDATE reports SET resolved = true, resolved_at = now(), resolved_by = $2 WHERE release_id = $1 AND NOT resolved", [releaseId, by]);
	return changed > 0;
}

/** Suspends a publisher: every token and session ends, nothing new can be
 *  published, and their apps leave the catalog (downloads answer 404) until
 *  someone lifts the suspension. Nothing is deleted. */
export async function suspendPublisher(sql: Sql, publisherId: number, { by, reason }: { by: string; reason: string }): Promise<boolean> {
	const row = await sql.one("UPDATE publishers SET suspended_at = now(), suspended_reason = $2 WHERE id = $1 RETURNING name", [publisherId, reason]);
	if (!row) return false;
	await sql.query("DELETE FROM tokens WHERE publisher_id = $1", [publisherId]);
	await logEvent(sql, by, "publisher.suspend", row.name, reason);
	return true;
}

export async function unsuspendPublisher(sql: Sql, publisherId: number, { by }: { by: string }): Promise<boolean> {
	const row = await sql.one("UPDATE publishers SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1 RETURNING name", [publisherId]);
	if (!row) return false;
	await logEvent(sql, by, "publisher.unsuspend", row.name);
	return true;
}

// --- settings the moderation site controls --------------------------------------
export interface StoreSettings {
	/** New publisher accounts can be created. */
	registration: boolean;
	/** Publishers can create releases. */
	publishing: boolean;
}

const DEFAULT_SETTINGS: StoreSettings = { registration: true, publishing: true };

export async function readSettings(sql: Sql): Promise<StoreSettings> {
	const rows = await sql.query("SELECT key, value FROM settings");
	const settings = { ...DEFAULT_SETTINGS };
	for (const row of rows) if (row.key in settings) (settings as any)[row.key] = row.value === true;
	return settings;
}

export async function writeSetting(sql: Sql, key: keyof StoreSettings, value: boolean, by: string): Promise<void> {
	await sql.query(
		"INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by",
		[key, JSON.stringify(value), by],
	);
	await logEvent(sql, by, "settings.change", key, value ? "on" : "off");
}
