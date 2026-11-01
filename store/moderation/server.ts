// Store moderation: a separate, LAN-only site on the store's Postgres database.
//
// The public store only collects releases and reports. This site decides:
// it runs the automatic checks (checks.ts) and gives moderators a queue, the
// release's files and findings, and the levers: approve, reject, take down,
// suspend or trust a publisher, pause registration or publishing. Decisions go
// straight into the shared tables (through releases.ts, the same code the
// store uses) and every one is logged with the moderator's name.
//
// It needs: DATABASE_URL (the store's database), the store's data volume
// read-only (STORE_DATA_DIR, for the bundles) and MODERATION_PASSWORD. Keep it
// off the internet: it holds the keys to the catalog.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Db, migrate, openDb } from "../db.ts";
import { logEvent, publishRelease, readSettings, REJECTED_KEEP_DAYS, rejectRelease, suspendPublisher, unsuspendPublisher, writeSetting } from "../releases.ts";
import { bundleFiles, createChecker, DEFAULT_POLICY, type Policy } from "./checks.ts";
import type { ClassifierConfig } from "./jev.ts";
import { ago, csrfField, esc, findingsList, layout, loginPage, riskChip, size, statusChip } from "./pages.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_HOURS = 12;

const CSS = `
.inline { display: inline; margin: 0; }
.mod-logo { color: var(--accent); font-size: 1.1rem; }
.count-badge { display: inline-block; min-width: 18px; padding: 0 5px; line-height: 18px; vertical-align: 1px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-size: 0.7rem; text-align: center; }
.chip.risk-block { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
.chip.risk-ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
.login { max-width: 420px; margin: 8vh auto 0; }
.login h1 { margin-bottom: 6px; }
.flash { margin-bottom: 18px; }
table.list { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
table.list th, table.list td { text-align: left; padding: 10px 12px; vertical-align: top; }
table.list th { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); font-weight: 600; }
table.list tr + tr td { border-top: 1px solid var(--line); }
table.list td.num { text-align: right; white-space: nowrap; }
.app-name { font-weight: 600; color: var(--ink); text-decoration: none; }
.app-icon-sm { display: inline-block; width: 1.6em; text-align: center; }
.findings { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.findings li { display: grid; grid-template-columns: 44px 1fr; gap: 10px; padding: 9px 11px; border-radius: 10px; background: var(--surface-2); }
.findings li.f-block { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.findings li.f-review { background: color-mix(in srgb, #f59e0b 13%, transparent); }
.findings .risk { padding-top: 2px; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
.stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.nowrap { white-space: nowrap; }
table.list td.wrap { overflow-wrap: anywhere; }
.panel h2 { margin-bottom: 10px; }
.actions form { display: grid; gap: 8px; margin: 0 0 14px; }
.actions textarea { min-height: 70px; font: inherit; }
pre.file { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 14px; overflow: auto; font: 0.8rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 75vh; }
.desc { white-space: pre-wrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; }
.kv dt { color: var(--dim); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.tabs { margin-bottom: 18px; }
.muted-row td { opacity: 0.6; }
.toolbar { margin: 0; }

/* Phones and narrow windows: the bar wraps (brand and sign-out on top, every
   tab below in a grid, counts visible), and tables become stacked cards. */
@media (max-width: 900px) {
	.bar { position: relative; top: 0; flex-wrap: wrap; row-gap: 8px; padding: 8px; }
	.bar .brand { padding-left: 4px; }
	.bar .brand .mod-logo { display: inline; }
	.bar-end { margin-left: auto; }
	.bar .nav { order: 3; flex-basis: 100%; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; overflow: visible; }
	.bar .nav a { text-align: center; padding: 7px 4px; }
}
@media (max-width: 760px) {
	.page-head { margin-bottom: 18px; }
	.page-head .toolbar { width: 100%; }
	.page-head .toolbar .input { flex: 1; min-width: 0; }
	table.list, table.list tbody, table.list tr { display: block; }
	table.list thead { display: none; }
	table.list tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; padding: 12px 14px; }
	table.list tr + tr { border-top: 1px solid var(--line); }
	table.list td { padding: 0; border: 0 !important; text-align: left; min-width: 0; }
	table.list tr + tr td { border-top: 0; }
	table.list td.c-main, table.list td.c-wide { flex-basis: 100%; }
	table.list td.c-empty { display: none; }
	table.list td.num { text-align: left; }
	table.list td.num:last-child { margin-left: auto; }
	table.list td[data-label]::before { content: attr(data-label) " "; color: var(--dim); font-size: 0.8rem; }
	table.list td.nowrap { white-space: normal; }
	.app-name { overflow-wrap: anywhere; }
	.kv { grid-template-columns: 1fr; gap: 2px; }
	.kv dd { margin-bottom: 8px; }
	.page-head h1 { font-size: 1.6rem; overflow-wrap: anywhere; }
}
@media (max-width: 420px) { .hide-xs { display: none; } }
`;

export interface ModerationOptions {
	port?: number | string;
	host?: string;
	databaseUrl?: string;
	db?: Db;
	dataDir?: string;
	password?: string;
	storeUrl?: string;
	policy?: Partial<Policy>;
	classifier?: ClassifierConfig | null;
	/** Run the check worker (tests drive it by hand). */
	worker?: boolean;
	logging?: boolean;
}

const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === "" ? fallback : value === "1" || value === "true");

export function classifierFromEnv(env = process.env): ClassifierConfig | null {
	if (!env.JEV_URL && !env.JEV_API_KEY) return null;
	return { url: env.JEV_URL || "https://api.typesafe.ai/v1/systemone", apiKey: env.JEV_API_KEY || undefined, model: env.JEV_MODEL || "jev-latest" };
}

export function policyFromEnv(env = process.env): Policy {
	return {
		reviewAt: Number(env.MODERATION_REVIEW_AT || DEFAULT_POLICY.reviewAt),
		blockAt: Number(env.MODERATION_BLOCK_AT || DEFAULT_POLICY.blockAt),
		autoBlock: flag(env.MODERATION_AUTO_BLOCK, DEFAULT_POLICY.autoBlock),
		autoApprove: flag(env.MODERATION_AUTO_APPROVE, DEFAULT_POLICY.autoApprove),
		autoApproveTrusted: flag(env.MODERATION_AUTO_APPROVE_TRUSTED, DEFAULT_POLICY.autoApproveTrusted),
	};
}

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function createModeration(options: ModerationOptions = {}) {
	const config = {
		port: Number(options.port ?? process.env.PORT ?? 3000),
		host: options.host ?? process.env.HOST ?? "0.0.0.0",
		databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL ?? "",
		dataDir: resolve(options.dataDir ?? process.env.STORE_DATA_DIR ?? "/data"),
		password: options.password ?? process.env.MODERATION_PASSWORD ?? "",
		storeUrl: String(options.storeUrl ?? process.env.STORE_PUBLIC_URL ?? "").replace(/\/+$/, ""),
		policy: { ...policyFromEnv(), ...options.policy },
		classifier: options.classifier === undefined ? classifierFromEnv() : options.classifier,
		worker: options.worker !== false,
		logging: options.logging !== false,
	};
	if (config.password.length < 12) throw new Error("set MODERATION_PASSWORD (12 or more characters)");
	if (!options.db && !config.databaseUrl) throw new Error("set DATABASE_URL to the store's database");
	const blobsDir = join(config.dataDir, "blobs");
	const blobFile = (sha: string) => join(blobsDir, `${sha}.tgz`);

	let db: Db = options.db ?? null;
	let checker: ReturnType<typeof createChecker> = null;

	const uiCss = (() => {
		for (const file of [join(HERE, "..", "web", "build", "ui.css"), join(HERE, "..", "..", "packages", "ui", "style.css")]) {
			if (existsSync(file)) return readFileSync(file);
		}
		return Buffer.from("");
	})();

	// --- sessions: in memory, a restart signs everyone out ----------------------
	const sessions = new Map<string, { name: string; csrf: string; expires: number }>();
	const digest = (s: string) => createHash("sha256").update(s).digest();
	const passwordOk = (given: string) => timingSafeEqual(digest(given), digest(config.password));
	const attempts = new Map<string, { n: number; reset: number }>();
	const tooManyAttempts = (ip: string) => {
		const at = Date.now();
		const a = attempts.get(ip);
		if (!a || a.reset < at) {
			attempts.set(ip, { n: 1, reset: at + 15 * 60_000 });
			return false;
		}
		return ++a.n > 10;
	};
	const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)mod_session=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie ?? ""))?.[1] ?? "";
	function sessionOf(req: IncomingMessage) {
		const id = cookieOf(req);
		const s = id ? sessions.get(id) : null;
		if (!s) return null;
		if (s.expires < Date.now()) {
			sessions.delete(id);
			return null;
		}
		return { id, ...s };
	}

	// --- helpers ------------------------------------------------------------------
	const HEADERS = {
		"x-content-type-options": "nosniff",
		// Not no-referrer: Chromium then sends "Origin: null" with form posts,
		// and the origin check below needs the real one.
		"referrer-policy": "same-origin",
		"x-frame-options": "DENY",
		"cache-control": "no-store",
		"content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	};
	const send = (res: ServerResponse, status: number, body: string | Buffer, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
		res.writeHead(status, { ...HEADERS, "content-type": type, "content-length": Buffer.byteLength(body), ...extra });
		res.end(body);
	};
	const redirect = (res: ServerResponse, to: string, extra: Record<string, string> = {}) => {
		res.writeHead(303, { ...HEADERS, location: to, ...extra });
		res.end();
	};
	async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > 32 * 1024) throw new HttpError(413, "form too large");
		}
		return new URLSearchParams(body);
	}
	const one = async (sqlText: string, params: unknown[] = []) => db.one(sqlText, params);

	// Published, and either the checks found something nobody has looked at yet
	// or someone reported it since.
	const FLAGGED = `r.status = 'published' AND ((r.reviewed_at IS NULL AND c.verdict IN ('review', 'block')) OR EXISTS (SELECT 1 FROM reports x WHERE x.release_id = r.id AND NOT x.resolved))`;

	async function counts() {
		const row = await one(`SELECT
			(SELECT count(*)::int FROM releases WHERE status = 'pending') AS queue,
			(SELECT count(*)::int FROM releases r LEFT JOIN moderation_checks c ON c.release_id = r.id WHERE ${FLAGGED}) AS flagged,
			(SELECT count(*)::int FROM reports WHERE NOT resolved) AS reports`);
		return row;
	}

	// Bundles are read whole; keep the last few for the file pages.
	const bundleCache = new Map<string, Promise<Awaited<ReturnType<typeof bundleFiles>>>>();
	function bundleOf(sha: string) {
		if (!bundleCache.has(sha)) {
			bundleCache.set(sha, bundleFiles(blobFile(sha)));
			bundleCache.get(sha).catch(() => bundleCache.delete(sha));
			while (bundleCache.size > 4) bundleCache.delete(bundleCache.keys().next().value);
		}
		return bundleCache.get(sha);
	}

	const RELEASE_ROW = `SELECT r.*, a.ref AS slug, a.slug AS bare_slug, a.name AS app_name, a.icon, p.id AS publisher_id, p.name AS publisher, p.trusted, p.suspended_at, p.created_at AS publisher_created,
			c.status AS check_status, c.verdict, c.risk, c.findings, c.classifier, c.action AS check_action, c.error AS check_error, c.finished_at AS checked_at,
			(SELECT count(*)::int FROM reports x WHERE x.release_id = r.id AND NOT x.resolved) AS open_reports
		FROM releases r JOIN apps a ON a.id = r.app_id JOIN publishers p ON p.id = a.publisher_id LEFT JOIN moderation_checks c ON c.release_id = r.id`;

	function releaseRow(r: any, showStatus: boolean): string {
		const top = (r.findings ?? []).find((f) => f.risk > 0);
		return `<tr${r.suspended_at ? ' class="muted-row"' : ""}>
				<td class="c-main"><span class="app-icon-sm">${esc(r.icon || "▫")}</span> <a class="app-name" href="/releases/${r.id}">${esc(r.app_name)}</a> <span class="dim mono small">${esc(r.slug)}@${esc(r.version)}</span>${r.open_reports ? ` <span class="chip warn">${r.open_reports} report${r.open_reports > 1 ? "s" : ""}</span>` : ""}</td>
				<td><a href="/publishers/${r.publisher_id}">${esc(r.publisher)}</a>${r.trusted ? ' <span class="chip risk-ok">trusted</span>' : ""}${r.suspended_at ? ' <span class="chip risk-block">suspended</span>' : ""}<div class="tiny dim">joined ${ago(r.publisher_created)}</div></td>
				<td>${riskChip(r.verdict, r.risk, r.check_status)}</td>
				<td class="small c-wide${top ? "" : " c-empty"}">${top ? esc(top.title) : '<span class="dim">—</span>'}</td>
				${showStatus ? `<td>${statusChip(r.status)}${r.reviewed_by ? `<div class="tiny dim">by ${esc(r.reviewed_by)}</div>` : ""}</td>` : ""}
				<td class="num small">${ago(r.reviewed_at && showStatus ? r.reviewed_at : r.created_at)}</td>
			</tr>`;
	}

	function releaseTable(rows: any[], empty: string, { showStatus = false } = {}): string {
		if (!rows.length) return `<div class="empty"><h2>${esc(empty)}</h2></div>`;
		return `<table class="list"><thead><tr><th>App</th><th>Publisher</th><th>Check</th><th>Top finding</th>${showStatus ? "<th>Status</th>" : ""}<th class="num">When</th></tr></thead><tbody>
		${rows.map((r) => releaseRow(r, showStatus)).join("")}</tbody></table>`;
	}

	// --- pages ----------------------------------------------------------------------
	async function queuePage(me, flash) {
		const rows = await db.query(
			`${RELEASE_ROW} WHERE r.status = 'pending'
			 ORDER BY CASE c.verdict WHEN 'block' THEN 0 WHEN 'review' THEN 1 WHEN 'allow' THEN 2 ELSE 1 END, c.risk DESC NULLS FIRST, r.created_at`,
		);
		return layout(
			{ title: "Queue", me, nav: "/", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Waiting for review</h1><p class="dim">Releases nobody can install yet, riskiest first. ${
				config.policy.autoApprove ? "Low-risk releases are approved automatically." : config.policy.autoApproveTrusted ? "Low-risk releases from trusted publishers skip this list." : "Every release waits for a person."
			}</p></div></div>${releaseTable(rows, "Nothing is waiting.")}`,
		);
	}

	async function flaggedPage(me, flash) {
		const rows = await db.query(
			`${RELEASE_ROW} WHERE ${FLAGGED}
			 ORDER BY c.risk DESC NULLS LAST, r.published_at DESC`,
		);
		return layout(
			{ title: "Flagged", me, nav: "/flagged", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Flagged in the catalog</h1><p class="dim">Published releases the checks or a report point at. Keep them, or take them down.</p></div></div>${releaseTable(rows, "Nothing published looks wrong.")}`,
		);
	}

	async function blockedPage(me, flash) {
		const rows = await db.query(`${RELEASE_ROW} WHERE r.status = 'rejected' ORDER BY r.reviewed_at DESC NULLS LAST LIMIT 200`);
		return layout(
			{ title: "Blocked", me, nav: "/blocked", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Blocked and rejected</h1><p class="dim">Bundles stay ${REJECTED_KEEP_DAYS} days after the decision, so a mistake can be reversed. Entries by <span class="mono">checks</span> were blocked automatically.</p></div></div>${releaseTable(rows, "Nothing was blocked.", { showStatus: true })}`,
		);
	}

	async function reportsPage(me, flash) {
		const rows = await db.query(
			`SELECT rep.*, r.id AS release_id, r.version, r.status, a.ref AS slug, a.name AS app_name, a.icon FROM reports rep JOIN releases r ON r.id = rep.release_id JOIN apps a ON a.id = r.app_id
			 WHERE NOT rep.resolved ORDER BY rep.created_at`,
		);
		const body = rows.length
			? `<table class="list"><thead><tr><th>App</th><th>Report</th><th class="num">When</th><th></th></tr></thead><tbody>${rows
					.map(
						(r) => `<tr><td class="c-main"><span class="app-icon-sm">${esc(r.icon || "▫")}</span> <a class="app-name" href="/releases/${r.release_id}">${esc(r.app_name)}</a> <span class="dim mono small">${esc(r.slug)}@${esc(r.version)}</span> ${statusChip(r.status)}</td>
					<td class="desc small c-wide">${esc(r.reason)}</td><td class="num small">${ago(r.created_at)}</td>
					<td><form method="post" action="/reports/${r.id}/resolve" class="inline">${csrfField(me.csrf)}<button class="button ghost small">Dismiss</button></form></td></tr>`,
					)
					.join("")}</tbody></table>`
			: `<div class="empty"><h2>No open reports.</h2></div>`;
		return layout(
			{ title: "Reports", me, nav: "/reports", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Reports</h1><p class="dim">From anyone, no account needed. Taking a release down closes its reports.</p></div></div>${body}`,
		);
	}

	async function publishersPage(me, flash, q: string) {
		const rows = await db.query(
			`SELECT p.*, (SELECT count(*)::int FROM apps a WHERE a.publisher_id = p.id) AS apps,
				(SELECT count(*)::int FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = p.id AND r.status = 'published') AS published,
				(SELECT count(*)::int FROM releases r JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = p.id AND r.status = 'rejected') AS rejected,
				(SELECT count(*)::int FROM reports x JOIN releases r ON r.id = x.release_id JOIN apps a ON a.id = r.app_id WHERE a.publisher_id = p.id) AS reports
			 FROM publishers p WHERE ($1 = '' OR strpos(p.name, $1) > 0) ORDER BY p.created_at DESC LIMIT 200`,
			[q],
		);
		return layout(
			{ title: "Publishers", me, nav: "/publishers", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Publishers</h1><p class="dim">Accounts exist only to publish. Suspending one hides all their apps at once.</p></div>
			<form method="get" action="/publishers" class="toolbar"><input class="input" name="q" value="${esc(q)}" placeholder="Name contains…"><button class="button ghost">Find</button></form></div>
			<table class="list"><thead><tr><th>Name</th><th class="num">Apps</th><th class="num">Published</th><th class="num">Rejected</th><th class="num">Reports</th><th class="num">Joined</th></tr></thead><tbody>
			${rows
				.map(
					(p) => `<tr${p.suspended_at ? ' class="muted-row"' : ""}><td class="c-main"><a class="app-name" href="/publishers/${p.id}">${esc(p.name)}</a>${p.trusted ? ' <span class="chip risk-ok">trusted</span>' : ""}${p.suspended_at ? ' <span class="chip risk-block">suspended</span>' : ""}</td>
				<td class="num" data-label="Apps">${p.apps}</td><td class="num" data-label="Published">${p.published}</td><td class="num" data-label="Rejected">${p.rejected}</td><td class="num" data-label="Reports">${p.reports}</td><td class="num small" data-label="Joined">${ago(p.created_at)}</td></tr>`,
				)
				.join("")}</tbody></table>`,
		);
	}

	async function publisherPage(me, flash, id: number) {
		const p = await one("SELECT * FROM publishers WHERE id = $1", [id]);
		if (!p) throw new HttpError(404, "no such publisher");
		const releases = await db.query(`${RELEASE_ROW} WHERE p.id = $1 ORDER BY r.created_at DESC LIMIT 200`, [id]);
		const events = await db.query("SELECT * FROM events WHERE actor = $1 OR target = $1 ORDER BY at DESC LIMIT 50", [p.name]);
		return layout(
			{ title: p.name, me, nav: "/publishers", counts: await counts(), flash },
			`<div class="page-head"><div><p class="dim small"><a href="/publishers">Publishers</a></p><h1>${esc(p.name)}</h1>
			<p class="dim">Joined ${ago(p.created_at)}${p.policy_accepted_at ? ", accepted the content policy" : ", before the content policy"}.</p></div></div>
			<div class="grid2"><div class="stack">
				<section><h2 class="gap-bottom">Releases</h2>${releaseTable(releases, "No releases.", { showStatus: true })}</section>
				<section class="panel"><h2>Log</h2>${eventsList(events)}</section>
			</div>
			<aside class="panel actions"><h2>Account</h2>
				${p.suspended_at ? `<p class="callout error">Suspended ${ago(p.suspended_at)}: ${esc(p.suspended_reason)}</p>` : ""}
				${
					p.suspended_at
						? `<form method="post" action="/publishers/${p.id}/unsuspend">${csrfField(me.csrf)}<button class="button ghost">Lift the suspension</button></form>`
						: `<form method="post" action="/publishers/${p.id}/suspend">${csrfField(me.csrf)}<label class="small" for="reason">Reason (the publisher sees it)</label><textarea class="input" id="reason" name="reason" required minlength="5" maxlength="500"></textarea><button class="button danger">Suspend: sign out, hide every app</button></form>`
				}
				<form method="post" action="/publishers/${p.id}/${p.trusted ? "untrust" : "trust"}">${csrfField(me.csrf)}<button class="button ghost">${p.trusted ? "Stop trusting" : "Trust this publisher"}</button>
				<p class="tiny dim">${config.policy.autoApproveTrusted ? "Low-risk releases from trusted publishers are published without waiting." : "Trust is shown in the queue; it approves nothing on its own."}</p></form>
			</aside></div>`,
		);
	}

	function eventsList(events: any[]) {
		if (!events.length) return `<p class="dim">Nothing yet.</p>`;
		return `<table class="list"><tbody>${events
			.map((e) => `<tr><td class="small nowrap">${ago(e.at)}</td><td class="small"><b>${esc(e.actor)}</b></td><td class="small mono">${esc(e.action)}</td><td class="small nowrap">${esc(e.target)}</td><td class="small dim wrap c-wide${e.note ? "" : " c-empty"}">${esc(e.note ?? "")}</td></tr>`)
			.join("")}</tbody></table>`;
	}

	async function logPage(me, flash, q: string) {
		const events = await db.query("SELECT * FROM events WHERE ($1 = '' OR strpos(target, $1) > 0 OR actor = $1) ORDER BY at DESC LIMIT 300", [q]);
		return layout(
			{ title: "Log", me, nav: "/log", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Log</h1><p class="dim">Everything publishers, the checks and moderators did.</p></div>
			<form method="get" action="/log" class="toolbar"><input class="input" name="q" value="${esc(q)}" placeholder="App, publisher or moderator"><button class="button ghost">Filter</button></form></div>${eventsList(events)}`,
		);
	}

	async function settingsPage(me, flash) {
		const s = await readSettings(db);
		const p = config.policy;
		const switchForm = (key: string, on: boolean, label: string, offText: string) =>
			`<form method="post" action="/settings" class="row">${csrfField(me.csrf)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="value" value="${on ? "0" : "1"}">
			<div class="grow"><b>${label}</b><div class="dim small">${on ? "On" : offText}</div></div><button class="button ${on ? "danger" : "ghost"} small">${on ? "Pause" : "Turn on"}</button></form>`;
		return layout(
			{ title: "Settings", me, nav: "/settings", counts: await counts(), flash },
			`<div class="page-head"><div><h1>Settings</h1><p class="dim">Switches take effect on the store within a few seconds.</p></div></div>
			<div class="rows">${switchForm("registration", s.registration, "New publisher accounts", "Paused: the store refuses sign-ups")}${switchForm("publishing", s.publishing, "Publishing", "Paused: no new releases")}</div>
			<section class="panel gap-top"><h2>Automatic checks</h2><dl class="kv">
				<dt>Review from risk</dt><dd>${p.reviewAt}</dd><dt>Block from risk</dt><dd>${p.blockAt}</dd>
				<dt>Block automatically</dt><dd>${p.autoBlock ? "yes" : "no"}</dd>
				<dt>Approve low risk</dt><dd>${p.autoApprove ? "every publisher" : p.autoApproveTrusted ? "trusted publishers only" : "never"}</dd>
				<dt>Classifier</dt><dd>${config.classifier ? `${esc(config.classifier.model)} at ${esc(new URL(config.classifier.url).host)}` : "off (set JEV_URL or JEV_API_KEY)"}</dd>
			</dl><p class="tiny dim gap-top">Set with MODERATION_* and JEV_* in the environment; see store/README.md.</p></section>`,
		);
	}

	async function releasePage(me, flash, id: number) {
		const r = await one(`${RELEASE_ROW} WHERE r.id = $1`, [id]);
		if (!r) throw new HttpError(404, "no such release");
		const m = r.manifest ?? {};
		const hasBlob = r.bundle_sha && existsSync(blobFile(r.bundle_sha));
		let files: any[] = [];
		let changes = "";
		let bundleError = "";
		if (hasBlob) {
			try {
				const bundle = await bundleOf(r.bundle_sha);
				files = bundle.files;
				const prev = await one(
					"SELECT version, bundle_sha FROM releases WHERE app_id = $1 AND id != $2 AND status IN ('published', 'yanked') AND bundle_sha IS NOT NULL AND created_at < $3 ORDER BY created_at DESC LIMIT 1",
					[r.app_id, r.id, r.created_at],
				);
				if (prev && existsSync(blobFile(prev.bundle_sha))) {
					const old = await bundleOf(prev.bundle_sha);
					const before = new Map(old.files.map((f: any) => [f.path, f.hash]));
					const after = new Map(files.map((f: any) => [f.path, f.hash]));
					const added = files.filter((f) => !before.has(f.path)).map((f) => f.path);
					const changed = files.filter((f) => before.has(f.path) && before.get(f.path) !== f.hash).map((f) => f.path);
					const removed = old.files.filter((f: any) => !after.has(f.path)).map((f: any) => f.path);
					const list = (label: string, paths: string[]) => (paths.length ? `<dt>${label}</dt><dd class="mono small">${paths.slice(0, 30).map(esc).join("<br>")}${paths.length > 30 ? ` … ${paths.length - 30} more` : ""}</dd>` : "");
					changes = `<section class="panel"><h2>Since ${esc(prev.version)}</h2><dl class="kv"><dt>Server code</dt><dd>${old.source === bundle.source ? "unchanged" : "<b>changed</b>"}</dd>${list("Added", added)}${list("Changed", changed)}${list("Removed", removed)}</dl></section>`;
				}
			} catch (err) {
				bundleError = err.message;
			}
		}
		const fileLink = (path: string) => (path === "(server code)" ? `/releases/${r.id}/file?server=1` : files.some((f) => f.path === path) ? `/releases/${r.id}/file?path=${encodeURIComponent(path)}` : null);
		const c = r.classifier;
		const classifierBlock = c
			? c.error
				? `<p class="callout error small">The classifier failed: ${esc(c.error)}</p>`
				: `<dl class="kv small"><dt>Harm</dt><dd>${Number(c.harm?.score).toFixed(2)} of 4 (risk ${Number(c.risk).toFixed(2)})</dd><dt>Looks like</dt><dd>${esc(c.kind?.choice)}${c.kind?.confidence != null ? ` · ${Number(c.kind.confidence).toFixed(2)}` : ""}</dd>
				<dt>Impersonation</dt><dd>${Number(c.impersonation).toFixed(2)}</dd><dt>Asks for secrets</dt><dd>${Number(c.collectsSecrets).toFixed(2)}</dd><dt>Model</dt><dd class="mono">${esc(c.model)} · ${esc(c.ms)} ms</dd></dl>`
			: `<p class="dim small">${config.classifier ? "Not classified yet." : "No classifier configured."}</p>`;
		const reports = await db.query("SELECT * FROM reports WHERE release_id = $1 ORDER BY created_at DESC", [r.id]);
		// Events from before namespaces name the app without its publisher.
		const events = await db.query("SELECT * FROM events WHERE target = ANY($1) ORDER BY at DESC LIMIT 50", [[`${r.slug}@${r.version}`, `${r.bare_slug}@${r.version}`]]);
		const field = (name: string, label: string, required = true) =>
			`<label class="small" for="${name}-${r.id}">${label}</label><textarea class="input" id="${name}-${r.id}" name="note" ${required ? 'required minlength="5"' : ""} maxlength="1000"></textarea>`;
		const actions: string[] = [];
		if (r.status === "pending") {
			actions.push(`<form method="post" action="/releases/${r.id}/approve">${csrfField(me.csrf)}<button class="button">Approve and publish</button></form>`);
			actions.push(`<form method="post" action="/releases/${r.id}/reject">${csrfField(me.csrf)}${field("reject", "Reason (the publisher sees it)")}<button class="button danger">Reject</button></form>`);
		} else if (r.status === "published") {
			if (!r.reviewed_at) actions.push(`<form method="post" action="/releases/${r.id}/keep">${csrfField(me.csrf)}<button class="button ghost">Looks fine: keep it</button></form>`);
			actions.push(`<form method="post" action="/releases/${r.id}/reject">${csrfField(me.csrf)}${field("takedown", "Reason (the publisher sees it)")}<button class="button danger">Take down</button></form>`);
		} else if (r.status === "rejected") {
			actions.push(
				hasBlob
					? `<form method="post" action="/releases/${r.id}/approve">${csrfField(me.csrf)}<button class="button ghost">Reverse: approve and publish</button></form>`
					: `<p class="dim small">The bundle is gone, so this cannot be reversed.</p>`,
			);
		}
		// The store lost this release's file: nobody can install it and nothing
		// can be reviewed. The only honest state left is removed.
		const lost = r.bundle_sha && !hasBlob && ["pending", "published", "yanked"].includes(r.status);
		if (lost) {
			actions.length = 0;
			actions.push(`<p class="callout error small">The bundle file is missing from the store, so this release cannot be installed or reviewed. Remove it; the version number stays taken, and the publisher can publish a new version.</p>
			<form method="post" action="/releases/${r.id}/remove">${csrfField(me.csrf)}<label class="small" for="remove-${r.id}">Note (the publisher sees it)</label><textarea class="input" id="remove-${r.id}" name="note" required minlength="5" maxlength="1000">The store lost this release's file. Please publish a new version.</textarea><button class="button danger">Remove this release</button></form>`);
		}
		if (!lost && r.bundle_sha && (r.status === "pending" || r.status === "published")) {
			actions.push(`<form method="post" action="/releases/${r.id}/recheck">${csrfField(me.csrf)}<button class="button quiet small">Run the checks again</button></form>`);
		}
		return layout(
			{ title: `${r.slug}@${r.version}`, me, nav: r.status === "pending" ? "/" : r.status === "rejected" ? "/blocked" : "/flagged", counts: await counts(), flash },
			`<div class="page-head"><div><p class="dim small"><a href="/">Queue</a></p>
				<h1><span class="app-icon-sm">${esc(r.icon || m.icon || "▫")}</span> ${esc(m.name ?? r.app_name)} <span class="dim mono">${esc(r.version)}</span></h1>
				<p>${statusChip(r.status)} ${riskChip(r.verdict, r.risk, r.check_status)} by <a href="/publishers/${r.publisher_id}">${esc(r.publisher)}</a>${r.trusted ? ' <span class="chip risk-ok">trusted</span>' : ""}${r.suspended_at ? ' <span class="chip risk-block">suspended</span>' : ""}
				· submitted ${ago(r.created_at)}${r.reviewed_by ? ` · decided by <b>${esc(r.reviewed_by)}</b> ${ago(r.reviewed_at)}` : ""}
				${r.status === "published" && config.storeUrl ? ` · <a href="${esc(config.storeUrl)}/apps/${esc(r.slug)}" rel="noreferrer">in the store</a>` : ""}</p>
				${r.review_note ? `<p class="callout small">Note to the publisher: ${esc(r.review_note)}</p>` : ""}
			</div></div>
			<div class="grid2"><div class="stack">
				<section class="panel"><h2>Automatic checks</h2>
					${r.check_error ? `<p class="callout error small">${esc(r.check_error)}</p>` : ""}
					${findingsList(r.findings ?? [], fileLink)}
					<h3 class="gap-top">Classifier</h3>${classifierBlock}
					${r.check_action ? `<p class="tiny dim gap-top">The checks ${esc(r.check_action)} this release on their own.</p>` : ""}
				</section>
				<section class="panel"><h2>Listing</h2><dl class="kv">
					<dt>Summary</dt><dd>${esc(m.summary)}</dd>
					<dt>Description</dt><dd class="desc">${esc(m.description) || '<span class="dim">—</span>'}</dd>
					<dt>Category</dt><dd>${esc(m.category ?? "—")}</dd><dt>Tags</dt><dd>${(m.tags ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join(" ") || "—"}</dd>
					<dt>Network</dt><dd>${(m.egress ?? []).length ? (m.egress ?? []).map((h) => `<span class="chip warn mono">${esc(h)}</span>`).join(" ") : "none"}</dd>
					<dt>Homepage</dt><dd class="mono small">${esc(m.homepage ?? "—")}</dd><dt>Source</dt><dd class="mono small">${esc(m.source ?? "—")}</dd>
					<dt>License</dt><dd>${esc(m.license)}</dd>
					${(m.permissions ?? []).length ? `<dt>Permissions</dt><dd>${m.permissions.map((p) => esc(p.title)).join(", ")}</dd>` : ""}
				</dl></section>
				${changes}
				<section class="panel"><h2>Files</h2>
					${bundleError ? `<p class="callout error small">${esc(bundleError)}</p>` : ""}
					${
						hasBlob
							? `<p class="small"><a href="/releases/${r.id}/file?server=1">Server code</a> <span class="dim">· bundle ${size(r.bundle_size)} · sha256 <span class="mono">${esc(r.bundle_sha.slice(0, 16))}…</span></span></p>
							<table class="list"><tbody>${files
								.slice(0, 300)
								.map((f) => `<tr><td class="mono small c-main wrap">${f.text !== undefined ? `<a href="/releases/${r.id}/file?path=${encodeURIComponent(f.path)}">${esc(f.path)}</a>` : esc(f.path)}</td><td class="small dim">${esc(f.type)}</td><td class="num small">${size(f.size)}</td></tr>`)
								.join("")}</tbody></table>${files.length > 300 ? `<p class="dim small">… and ${files.length - 300} more</p>` : ""}`
							: `<p class="dim">The bundle is not stored (removed, or past the keep time).</p>`
					}
				</section>
				${reports.length ? `<section class="panel"><h2>Reports</h2><ul class="findings">${reports.map((x) => `<li class="${x.resolved ? "f-info" : "f-review"}"><span class="tiny dim">${ago(x.created_at)}</span><div class="desc small">${esc(x.reason)}${x.resolved ? ` <span class="dim">(closed by ${esc(x.resolved_by ?? "?")})</span>` : ""}</div></li>`).join("")}</ul></section>` : ""}
				<section class="panel"><h2>Log</h2>${eventsList(events)}</section>
			</div>
			<aside class="panel actions"><h2>Decide</h2>${actions.join("") || '<p class="dim small">Nothing to decide: this release is ' + esc(r.status) + ".</p>"}</aside></div>`,
		);
	}

	async function filePage(me, id: number, url: URL) {
		const r = await one("SELECT r.id, r.version, r.bundle_sha, a.ref AS slug FROM releases r JOIN apps a ON a.id = r.app_id WHERE r.id = $1", [id]);
		if (!r?.bundle_sha || !existsSync(blobFile(r.bundle_sha))) throw new HttpError(404, "the bundle is not stored");
		const bundle = await bundleOf(r.bundle_sha);
		const server = url.searchParams.get("server") === "1";
		const path = url.searchParams.get("path") ?? "";
		let text: string;
		let label: string;
		if (server) {
			text = bundle.source;
			label = "Server code";
		} else {
			const f = bundle.files.find((x) => x.path === path);
			if (!f) throw new HttpError(404, "no such file");
			if (f.text === undefined) throw new HttpError(415, "binary or very large file; not shown");
			text = f.text;
			label = path;
		}
		const LIMIT = 400_000;
		return layout(
			{ title: label, me, counts: await counts() },
			`<p class="dim small"><a href="/releases/${r.id}">${esc(r.slug)}@${esc(r.version)}</a></p><h1 class="mono gap-bottom">${esc(label)}</h1>
			<p class="dim small">Shown as text, never run. ${text.length > LIMIT ? `First ${LIMIT.toLocaleString("en")} of ${text.length.toLocaleString("en")} characters.` : `${text.length.toLocaleString("en")} characters.`}</p>
			<pre class="file">${esc(text.slice(0, LIMIT))}</pre>`,
		);
	}

	// --- actions ----------------------------------------------------------------------
	const note = (form: URLSearchParams, required = true) => {
		const value = String(form.get("note") ?? "").trim();
		if (required && (value.length < 5 || value.length > 1000)) throw new HttpError(400, "write a reason of 5 to 1000 characters");
		return value || null;
	};

	async function act(me, pathname: string, form: URLSearchParams): Promise<{ to: string; flash: string }> {
		let m = /^\/releases\/(\d+)\/(approve|reject|keep|recheck|remove)$/.exec(pathname);
		if (m) {
			const id = Number(m[1]);
			const r = await one("SELECT r.*, a.ref AS slug FROM releases r JOIN apps a ON a.id = r.app_id WHERE r.id = $1", [id]);
			if (!r) throw new HttpError(404, "no such release");
			const target = `${r.slug}@${r.version}`;
			const to = `/releases/${id}`;
			if (m[2] === "approve") {
				if (!r.bundle_sha || !existsSync(blobFile(r.bundle_sha))) throw new HttpError(409, "the bundle is gone; this release cannot be published");
				const ok = await db.tx(async (sql) => {
					if (!(await publishRelease(sql, id, { by: me.name }))) return false;
					await logEvent(sql, me.name, r.status === "rejected" ? "release.reverse" : "release.approve", target);
					return true;
				});
				if (!ok) throw new HttpError(409, `a ${r.status} release cannot be approved`);
				return { to, flash: `${target} is published.` };
			}
			if (m[2] === "reject") {
				const reason = note(form);
				const ok = await db.tx(async (sql) => {
					if (!(await rejectRelease(sql, id, { by: me.name, note: reason }))) return false;
					await logEvent(sql, me.name, r.status === "published" ? "release.takedown" : "release.reject", target, reason);
					return true;
				});
				if (!ok) throw new HttpError(409, `a ${r.status} release cannot be rejected`);
				return { to, flash: r.status === "published" ? `${target} was taken down.` : `${target} was rejected.` };
			}
			if (m[2] === "remove") {
				if (r.bundle_sha && existsSync(blobFile(r.bundle_sha))) throw new HttpError(409, "the bundle is there: reject or take the release down instead");
				const reason = note(form);
				const ok = await db.tx(async (sql) => {
					const changed = await sql.run(
						"UPDATE releases SET status = 'removed', reviewed_at = now(), reviewed_by = $2, review_note = $3 WHERE id = $1 AND status IN ('pending', 'published', 'yanked')",
						[id, me.name, reason],
					);
					if (!changed) return false;
					await sql.run("UPDATE reports SET resolved = true, resolved_at = now(), resolved_by = $2 WHERE release_id = $1 AND NOT resolved", [id, me.name]);
					await logEvent(sql, me.name, "release.remove", target, `bundle file missing: ${reason}`);
					return true;
				});
				if (!ok) throw new HttpError(409, `a ${r.status} release cannot be removed`);
				return { to, flash: `${target} is removed.` };
			}
			if (m[2] === "keep") {
				await db.tx(async (sql) => {
					await sql.run("UPDATE releases SET reviewed_at = now(), reviewed_by = $2 WHERE id = $1 AND status = 'published'", [id, me.name]);
					await sql.run("UPDATE reports SET resolved = true, resolved_at = now(), resolved_by = $2 WHERE release_id = $1 AND NOT resolved", [id, me.name]);
					await logEvent(sql, me.name, "release.keep", target);
				});
				return { to: "/flagged", flash: `${target} stays published.` };
			}
			await db.run("DELETE FROM moderation_checks WHERE release_id = $1", [id]);
			await logEvent(db, me.name, "release.recheck", target);
			if (checker) await checker.tick();
			return { to, flash: "The checks ran again." };
		}
		m = /^\/publishers\/(\d+)\/(suspend|unsuspend|trust|untrust)$/.exec(pathname);
		if (m) {
			const id = Number(m[1]);
			const to = `/publishers/${id}`;
			if (m[2] === "suspend") {
				const reason = String(form.get("reason") ?? "").trim();
				if (reason.length < 5 || reason.length > 500) throw new HttpError(400, "write a reason of 5 to 500 characters");
				if (!(await db.tx((sql) => suspendPublisher(sql, id, { by: me.name, reason })))) throw new HttpError(404, "no such publisher");
				return { to, flash: "Suspended. Their apps are out of the catalog and every sign-in ended." };
			}
			if (m[2] === "unsuspend") {
				if (!(await unsuspendPublisher(db, id, { by: me.name }))) throw new HttpError(404, "no such publisher");
				return { to, flash: "The suspension is lifted." };
			}
			const trusted = m[2] === "trust";
			const row = await one("UPDATE publishers SET trusted = $2 WHERE id = $1 RETURNING name", [id, trusted]);
			if (!row) throw new HttpError(404, "no such publisher");
			await logEvent(db, me.name, trusted ? "publisher.trust" : "publisher.untrust", row.name);
			return { to, flash: trusted ? `${row.name} is trusted.` : `${row.name} is no longer trusted.` };
		}
		m = /^\/reports\/(\d+)\/resolve$/.exec(pathname);
		if (m) {
			const row = await one(
				"UPDATE reports rep SET resolved = true, resolved_at = now(), resolved_by = $2 FROM releases r JOIN apps a ON a.id = r.app_id WHERE rep.id = $1 AND r.id = rep.release_id RETURNING a.ref AS slug, r.version",
				[Number(m[1]), me.name],
			);
			if (row) await logEvent(db, me.name, "report.dismiss", `${row.slug}@${row.version}`);
			return { to: "/reports", flash: "Report dismissed." };
		}
		if (pathname === "/settings") {
			const key = String(form.get("key"));
			if (key !== "registration" && key !== "publishing") throw new HttpError(400, "unknown setting");
			await writeSetting(db, key, form.get("value") === "1", me.name);
			return { to: "/settings", flash: `${key === "registration" ? "New accounts" : "Publishing"} ${form.get("value") === "1" ? "on" : "paused"}.` };
		}
		throw new HttpError(404, "no such action");
	}

	// --- HTTP -------------------------------------------------------------------------
	const server = createServer(async (req, res) => {
		let url: URL;
		try {
			url = new URL(req.url || "/", "http://localhost");
		} catch {
			return send(res, 400, "bad request", "text/plain; charset=utf-8");
		}
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const method = req.method ?? "GET";
		const started = Date.now();
		try {
			if (pathname === "/health") {
				const row = await one("SELECT (SELECT count(*)::int FROM releases WHERE status = 'pending') AS pending");
				return send(res, 200, JSON.stringify({ ok: true, pending: row.pending, classifier: Boolean(config.classifier) }), "application/json");
			}
			if (pathname === "/ui.css") return send(res, 200, uiCss, "text/css; charset=utf-8", { "cache-control": "public, max-age=300" });
			if (pathname === "/moderation.css") return send(res, 200, CSS, "text/css; charset=utf-8", { "cache-control": "public, max-age=300" });

			const header = String(process.env.STORE_CLIENT_IP_HEADER ?? "").toLowerCase();
			const ip = (header && String(req.headers[header] ?? "").trim()) || String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() || req.socket.remoteAddress || "?";
			if (pathname === "/login") {
				if (method === "GET") return send(res, 200, loginPage());
				if (method !== "POST") throw new HttpError(405, "method not allowed");
				if (tooManyAttempts(ip)) return send(res, 429, loginPage("Too many attempts. Wait a few minutes."));
				const form = await readForm(req);
				const name = String(form.get("name") ?? "").trim();
				if (!/^[\p{L}\p{N} ._-]{2,30}$/u.test(name)) return send(res, 400, loginPage("Use 2 to 30 letters, digits, spaces, dots or dashes for your name."));
				if (!passwordOk(String(form.get("password") ?? ""))) return send(res, 401, loginPage("Wrong password."));
				const id = randomBytes(24).toString("base64url");
				sessions.set(id, { name, csrf: randomBytes(18).toString("base64url"), expires: Date.now() + SESSION_HOURS * 3600_000 });
				await logEvent(db, name, "moderator.sign-in", "moderation", ip);
				const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
				return redirect(res, "/", { "set-cookie": `mod_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}` });
			}

			const me = sessionOf(req);
			if (!me) {
				if (method === "GET") return redirect(res, "/login");
				throw new HttpError(401, "sign in first");
			}

			if (method === "POST") {
				// Same-site form posts only: the session cookie is SameSite=Strict,
				// and the form carries this session's token.
				const origin = String(req.headers.origin ?? "");
				const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
				if (origin && URL.parse(origin)?.host !== host) throw new HttpError(403, "cross-site request refused");
				const form = await readForm(req);
				const token = String(form.get("_csrf") ?? "");
				if (token.length !== me.csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(me.csrf))) throw new HttpError(403, "the form expired; reload the page");
				if (pathname === "/logout") {
					sessions.delete(me.id);
					return redirect(res, "/login", { "set-cookie": "mod_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
				}
				const { to, flash } = await act(me, pathname, form);
				return redirect(res, `${to}${to.includes("?") ? "&" : "?"}done=${encodeURIComponent(flash)}`);
			}
			if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");

			const flash = url.searchParams.get("done");
			const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 60);
			const page = async () => {
				if (pathname === "/") return queuePage(me, flash);
				if (pathname === "/flagged") return flaggedPage(me, flash);
				if (pathname === "/blocked") return blockedPage(me, flash);
				if (pathname === "/reports") return reportsPage(me, flash);
				if (pathname === "/publishers") return publishersPage(me, flash, q);
				if (pathname === "/log") return logPage(me, flash, q);
				if (pathname === "/settings") return settingsPage(me, flash);
				let m = /^\/publishers\/(\d+)$/.exec(pathname);
				if (m) return publisherPage(me, flash, Number(m[1]));
				m = /^\/releases\/(\d+)$/.exec(pathname);
				if (m) return releasePage(me, flash, Number(m[1]));
				m = /^\/releases\/(\d+)\/file$/.exec(pathname);
				if (m) return filePage(me, Number(m[1]), url);
				throw new HttpError(404, "no such page");
			};
			return send(res, 200, await page());
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) console.error("moderation: request failed", err);
			const message = status === 500 ? "Something went wrong; the log has the details." : err.message;
			if (!res.headersSent) send(res, status, layout({ title: "Error", me: sessionOf(req) }, `<div class="empty"><h2>${esc(message)}</h2><p><a href="/">Back to the queue</a></p></div>`));
		} finally {
			if (config.logging && pathname !== "/health") console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
		}
	});
	server.requestTimeout = 60_000;
	server.headersTimeout = 15_000;

	return {
		config,
		server,
		get db() {
			return db;
		},
		get checker() {
			return checker;
		},
		async listen(port = config.port, host = config.host): Promise<AddressInfo> {
			if (!db) db = await openDb({ url: config.databaseUrl });
			await migrate(db);
			checker = createChecker({ db, blobsDir, policy: config.policy, classifier: config.classifier, log: config.logging ? console.log : () => {} });
			if (config.worker) checker.start();
			return new Promise((resolvePromise, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.off("error", reject);
					resolvePromise(server.address() as AddressInfo);
				});
			});
		},
		async close() {
			checker?.stop();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
			if (!options.db && db) await db.close();
		},
	};
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	const moderation = createModeration();
	const address = await moderation.listen();
	const p = moderation.config.policy;
	console.log(
		`moderation: on http://${address.address}:${address.port} (blobs ${moderation.config.dataDir}, classifier ${moderation.config.classifier ? moderation.config.classifier.model : "off"}, block from ${p.blockAt}${p.autoBlock ? " automatically" : ""}, auto-approve ${p.autoApprove ? "all" : p.autoApproveTrusted ? "trusted" : "never"})`,
	);
	const stop = async (signal: string) => {
		console.log(`moderation: ${signal}, shutting down`);
		await moderation.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("unhandledRejection", (reason) => console.error("moderation: unhandled rejection", reason));
}
