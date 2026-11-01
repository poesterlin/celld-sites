// HTML for the moderation site. Server-rendered, no client JavaScript: every
// value from the database is the publisher's and goes through esc().
import type { Finding } from "./scan.ts";

export const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function ago(at: unknown): string {
	if (!at) return "—";
	const t = new Date(at as string).getTime();
	const s = Math.round((Date.now() - t) / 1000);
	const rel = s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
	return `<time datetime="${esc(new Date(t).toISOString())}" title="${esc(new Date(t).toISOString().replace("T", " ").slice(0, 16))} UTC">${rel}</time>`;
}

export const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function riskChip(verdict: string | null, risk: number | null, status?: string | null): string {
	if (status === "running" || (!verdict && status !== "error")) return `<span class="chip">checking…</span>`;
	if (status === "error") return `<span class="chip warn" title="the check failed; look yourself">check failed</span>`;
	const cls = verdict === "block" ? "risk-block" : verdict === "review" ? "warn" : "risk-ok";
	return `<span class="chip ${cls}">${esc(verdict)}${risk != null ? ` · ${Number(risk).toFixed(2)}` : ""}</span>`;
}

export function statusChip(status: string): string {
	const cls = status === "published" ? "risk-ok" : status === "rejected" ? "risk-block" : status === "pending" ? "accent" : "";
	return `<span class="chip ${cls}">${esc(status === "pending" ? "waiting" : status)}</span>`;
}

export function findingsList(findings: Finding[], fileLink: (path: string) => string | null): string {
	if (!findings?.length) return `<p class="dim">The rules found nothing.</p>`;
	return `<ul class="findings">${findings
		.map((f) => {
			const link = f.file ? fileLink(f.file) : null;
			return `<li class="${f.risk >= 0.9 ? "f-block" : f.risk >= 0.4 ? "f-review" : "f-info"}">
				<span class="mono tiny risk">${f.risk.toFixed(2)}</span>
				<div><b>${esc(f.title)}</b>${f.detail ? `<div class="dim small">${esc(f.detail)}</div>` : ""}
				<div class="tiny dim mono">${esc(f.rule)}${f.file ? ` · ${link ? `<a href="${esc(link)}">${esc(f.file)}</a>` : esc(f.file)}` : ""}</div></div>
			</li>`;
		})
		.join("")}</ul>`;
}

export interface Shell {
	title: string;
	me?: { name: string; csrf: string } | null;
	nav?: string;
	counts?: { queue: number; flagged: number; reports: number };
	flash?: string | null;
}

export function layout({ title, me, nav, counts, flash }: Shell, body: string): string {
	const link = (href: string, label: string, n?: number) =>
		`<a href="${href}"${nav === href ? ' aria-current="page"' : ""}>${label}${n ? ` <span class="count-badge">${n}</span>` : ""}</a>`;
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Store moderation</title>
<link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/moderation.css">
</head><body>
${
	me
		? `<header class="bar">
	<a class="brand" href="/"><span class="mod-logo" aria-hidden="true">◆</span> Moderation</a>
	<nav class="nav">${link("/", "Queue", counts?.queue)}${link("/flagged", "Flagged", counts?.flagged)}${link("/reports", "Reports", counts?.reports)}${link("/blocked", "Blocked")}${link("/publishers", "Publishers")}${link("/log", "Log")}${link("/settings", "Settings")}</nav>
	<form method="post" action="/logout" class="inline bar-end"><input type="hidden" name="_csrf" value="${esc(me.csrf)}"><button class="button quiet small" title="Sign out ${esc(me.name)}"><span class="hide-xs">${esc(me.name)} · </span>Sign out</button></form>
</header>`
		: ""
}
<main class="page">${flash ? `<p class="callout flash">${esc(flash)}</p>` : ""}${body}</main>
</body></html>`;
}

export const csrfField = (csrf: string) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

export function loginPage(error?: string): string {
	return layout(
		{ title: "Sign in" },
		`<section class="panel login">
		<h1>Store moderation</h1>
		<p class="dim">Your name goes into the log with every decision.</p>
		${error ? `<p class="callout error">${esc(error)}</p>` : ""}
		<form method="post" action="/login">
			<div class="field"><label for="name">Your name</label><input class="input" id="name" name="name" required minlength="2" maxlength="30" autocomplete="username"></div>
			<div class="field"><label for="password">Moderator password</label><input class="input" id="password" name="password" type="password" required autocomplete="current-password"></div>
			<button class="button">Sign in</button>
		</form>
	</section>`,
	);
}
