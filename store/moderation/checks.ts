// The check worker: every release with a bundle gets one automatic check. It
// reads the bundle, runs the rules (scan.ts), asks the classifier if one is
// configured (jev.ts), stores the result in moderation_checks and applies the
// policy:
//
//   block  → rejected at once (if autoBlock), with the reason for the publisher;
//            a moderator can still approve it from the Blocked list.
//   review → stays in the queue (or, if already published, shows as flagged).
//   allow  → still waits for a human, unless autoApprove is on, or the
//            publisher is trusted and autoApproveTrusted is on.
//
// Several workers may run: a check is claimed by inserting its row, which only
// one of them can do.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBundle } from "../../packages/app-format/bundle.ts";
import type { Db, Sql } from "../db.ts";
import { nameConcerns } from "../names.ts";
import { logEvent, publishRelease, rejectRelease } from "../releases.ts";
import { type Classification, type ClassifierConfig, classifierRisk, classify, stateFor } from "./jev.ts";
import { type Finding, isText, type ScanFile, scanRelease, type Severity, severityOf } from "./scan.ts";

export interface Policy {
	reviewAt: number;
	blockAt: number;
	autoBlock: boolean;
	autoApprove: boolean;
	autoApproveTrusted: boolean;
}

export const DEFAULT_POLICY: Policy = { reviewAt: 0.4, blockAt: 0.9, autoBlock: true, autoApprove: false, autoApproveTrusted: true };

export interface CheckerOptions {
	db: Db;
	blobsDir: string;
	policy?: Partial<Policy>;
	classifier?: ClassifierConfig | null;
	/** Called when a release starts waiting for a person (ntfy, tests). */
	notify?: (message: string) => void | Promise<void>;
	log?: (message: string) => void;
}

const TEXT_LIMIT = 2 * 1024 * 1024;

const verdictOf = (risk: number, policy: Policy): "allow" | Severity =>
	((s) => (s === "info" ? "allow" : s))(severityOf(risk, policy));

/** The files of a stored bundle, text decoded, in code.json order. */
export async function bundleFiles(file: string): Promise<{ source: string; files: ScanFile[]; code: any; blobs: Map<string, Buffer> }> {
	const meta = await readBundle(file, { keepBlobs: true });
	const files = Object.entries(meta.code.files as Record<string, [string, string]>).map(([path, [hash, type]]) => {
		const buffer = meta.blobs.get(hash);
		const text = buffer && buffer.length <= TEXT_LIMIT && isText(type, path) ? buffer.toString("utf8") : undefined;
		return { path, type, size: buffer?.length ?? 0, text, hash };
	});
	return { source: meta.code.source, files, code: meta.code, blobs: meta.blobs };
}

export function createChecker({ db, blobsDir, policy: over = {}, classifier = null, notify, log = console.log }: CheckerOptions) {
	const policy: Policy = { ...DEFAULT_POLICY, ...over };

	/** New network access compared with the last published release. */
	async function egressChange(row: any): Promise<Finding[]> {
		const previous = await db.one(
			"SELECT version, manifest FROM releases WHERE app_id = $1 AND id != $2 AND status IN ('published', 'yanked') AND created_at < $3 ORDER BY created_at DESC LIMIT 1",
			[row.app_id, row.id, row.created_at],
		);
		if (!previous) return [];
		const before: string[] = previous.manifest?.egress ?? [];
		const added = (row.manifest?.egress ?? []).filter((h: string) => !before.includes(h));
		if (!added.length) return [];
		return [{ rule: "update.new-egress", risk: 0.5, title: `Asks for new network access: ${added.join(", ")}`, detail: `${previous.version} could not reach ${added.length === 1 ? "it" : "them"}.` }];
	}

	// A stolen account publishes with a fresh password or token. New accounts
	// have nothing but fresh credentials, so only older ones are judged.
	async function freshCredentials(row: any): Promise<Finding[]> {
		const day = 86400_000;
		if (Date.now() - new Date(row.publisher_created).getTime() <= 3 * day) return [];
		const fresh = await db.one(
			"SELECT max(created_at) AS token FROM tokens WHERE publisher_id = $1 AND kind = 'cli' AND created_at > now() - interval '72 hours'",
			[row.publisher_id],
		);
		const password = row.password_changed_at && Date.now() - new Date(row.password_changed_at).getTime() < 3 * day;
		if (!password && !fresh?.token) return [];
		return [
			{
				rule: "account.fresh-credentials",
				risk: 0.45,
				title: password ? "Published after a recent password change" : "Published with a token made in the last 3 days",
				detail: "Account takeovers publish this way. Worth a look even for a trusted publisher.",
			},
		];
	}

	async function lookalikeName(row: any): Promise<Finding[]> {
		const others = (await db.query("SELECT name FROM publishers WHERE id != $1", [row.publisher_id])).map((r) => r.name);
		return nameConcerns(row.publisher, others).map((concern) => ({
			rule: "publisher.name",
			risk: 0.5,
			title: `The publisher's name ${concern}`,
			detail: "Names are namespaces; a lookalike is how impersonation starts.",
		}));
	}

	/** What the bundle cannot show: how this release differs from the last
	 *  published one, and whether the account looks freshly taken over. These
	 *  hold back releases a trusted publisher would otherwise get through. */
	async function contextFindings(row: any): Promise<Finding[]> {
		return [...(await egressChange(row)), ...(await freshCredentials(row)), ...(await lookalikeName(row))];
	}

	/** Scan the stored bundle and, if configured, ask the classifier. Throws
	 *  when the bundle cannot be checked; a classifier failure is only noted. */
	async function analyze(row: any): Promise<{ findings: Finding[]; classification: Classification | null; classifierError: string | null }> {
		const file = join(blobsDir, `${row.bundle_sha}.tgz`);
		if (!existsSync(file)) throw new Error("the bundle file is missing from the store, so nobody can download this release");
		const bundle = await bundleFiles(file);
		const scan = scanRelease({ manifest: row.manifest, source: bundle.source, files: bundle.files });
		const findings = [...scan.findings, ...(await contextFindings(row))].sort((a, b) => b.risk - a.risk);
		if (!classifier) return { findings, classification: null, classifierError: null };
		const ageDays = Math.floor((Date.now() - new Date(row.publisher_created).getTime()) / 86400_000);
		try {
			const classification = await classify(classifier, stateFor(row.manifest, { name: row.publisher, ageDays, apps: row.publisher_apps }, scan, bundle.source));
			return { findings, classification, classifierError: null };
		} catch (err) {
			// The rules still decide; the queue shows that the classifier failed.
			return { findings, classification: null, classifierError: err.message };
		}
	}

	/** Apply the policy inside the transaction: reject, publish or leave it for
	 *  a person. Returns what was done. */
	async function applyPolicy(sql: Sql, row: any, verdict: string): Promise<string | null> {
		if (verdict === "block" && policy.autoBlock) {
			// The publisher hears that, not which rule fired: the details are for
			// moderators, not a guide to slipping past the checks.
			const note = "The store's automatic checks blocked this release because it may harm the people who use it. A moderator reviews every blocked release and can reverse the decision.";
			return (await rejectRelease(sql, row.id, { by: "checks", note })) ? "rejected" : null;
		}
		if (verdict === "allow" && row.status === "pending" && (policy.autoApprove || (row.trusted && policy.autoApproveTrusted))) {
			return (await publishRelease(sql, row.id, { by: "checks", note: row.trusted ? "trusted publisher, low risk" : "low risk" })) ? "published" : null;
		}
		return null;
	}

	async function checkOne(releaseId: number): Promise<void> {
		const row = await db.one(
			`SELECT r.*, a.ref AS slug, p.id AS publisher_id, p.name AS publisher, p.trusted, p.created_at AS publisher_created, p.password_changed_at,
				(SELECT count(*)::int FROM apps x WHERE x.publisher_id = p.id) AS publisher_apps
			 FROM releases r JOIN apps a ON a.id = r.app_id JOIN publishers p ON p.id = a.publisher_id WHERE r.id = $1`,
			[releaseId],
		);
		if (!row) return;
		const target = `${row.slug}@${row.version}`;
		let result: Awaited<ReturnType<typeof analyze>>;
		try {
			result = await analyze(row);
		} catch (err) {
			await db.run("UPDATE moderation_checks SET status = 'error', finished_at = now(), verdict = 'review', error = $2 WHERE release_id = $1", [releaseId, String(err.message ?? err)]);
			log(`moderation: checking ${target} failed: ${err.message}`);
			return;
		}
		const { findings, classification, classifierError } = result;

		const ruleRisk = findings.reduce((m, f) => Math.max(m, f.risk), 0);
		const risk = Math.max(ruleRisk, classification ? classifierRisk(classification) : 0);
		const verdict = verdictOf(risk, policy);
		const blockers = findings.filter((f) => f.risk >= policy.blockAt).map((f) => f.title);
		if (classification && classifierRisk(classification) >= policy.blockAt) blockers.push(`the classifier rated it ${classification.kind.choice.replace(/_/g, " ") || "harmful"}`);

		const action = await db.tx(async (sql) => {
			const done = await applyPolicy(sql, row, verdict);
			await sql.run(
				"UPDATE moderation_checks SET status = 'done', finished_at = now(), verdict = $2, risk = $3, findings = $4::jsonb, classifier = $5::jsonb, action = $6, error = $7 WHERE release_id = $1",
				[releaseId, verdict, risk, JSON.stringify(findings), classification || classifierError ? JSON.stringify(classification ?? { error: classifierError }) : null, done, classifierError],
			);
			await logEvent(sql, "checks", "release.check", target, `${verdict} (risk ${risk.toFixed(2)})${done ? `, ${done}` : ""}${blockers.length ? `: ${blockers.join("; ")}` : ""}`);
			return done;
		});
		log(`moderation: ${target} → ${verdict} (risk ${risk.toFixed(2)})${action ? `, ${action}` : ""}`);
		if (notify && !action && (row.status === "pending" || verdict !== "allow")) {
			await Promise.resolve(notify(`${target} by ${row.publisher}: ${verdict}, risk ${risk.toFixed(2)}${findings[0] && findings[0].risk > 0 ? ` (${findings[0].title})` : ""}`)).catch(() => {});
		}
	}

	/** One pass: requeue stuck checks, then check what is new. Returns how many
	 *  releases it checked. */
	async function tick(limit = 5): Promise<number> {
		await db.run("DELETE FROM moderation_checks WHERE status = 'running' AND started_at < now() - interval '10 minutes'");
		const due = await db.query(
			`SELECT r.id FROM releases r LEFT JOIN moderation_checks c ON c.release_id = r.id
			 WHERE c.release_id IS NULL AND r.bundle_sha IS NOT NULL AND r.status IN ('pending', 'published')
			 ORDER BY (r.status = 'pending') DESC, r.created_at LIMIT $1`,
			[limit],
		);
		let checked = 0;
		for (const { id } of due) {
			const claimed = await db.one("INSERT INTO moderation_checks (release_id, status, started_at) VALUES ($1, 'running', now()) ON CONFLICT DO NOTHING RETURNING release_id", [id]);
			if (!claimed) continue;
			await checkOne(id);
			checked++;
		}
		return checked;
	}

	let timer: NodeJS.Timeout | null = null;
	let running = false;
	return {
		policy,
		tick,
		start(intervalMs = 5000) {
			const run = async () => {
				if (running) return;
				running = true;
				try {
					while ((await tick()) > 0);
				} catch (err) {
					log(`moderation: check pass failed: ${err.message}`);
				} finally {
					running = false;
				}
			};
			timer = setInterval(run, intervalMs);
			timer.unref();
			void run();
		},
		stop() {
			if (timer) clearInterval(timer);
		},
	};
}
