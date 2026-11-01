// Deterministic checks on a release: what the listing claims, what the pages
// and code contain. They run before any classifier, cost nothing, and explain
// themselves: every finding names the rule, the file and the evidence.
//
// They look for signals, not proof. A password field is normal; a password
// field on a page that posts to another server is not. Each finding carries a
// risk from 0 to 1; the highest one decides (see verdictOf in checks.ts).
//
// Nothing here executes the app: files are read as text and matched.

export type Severity = "info" | "review" | "block";

export interface Finding {
	rule: string;
	risk: number;
	title: string;
	detail?: string;
	file?: string;
}

export interface ScanFile {
	path: string;
	type: string;
	size: number;
	/** The file as text; absent for binary files and files over the text limit. */
	text?: string;
}

export interface ScanInput {
	manifest: any;
	/** The worker's server code (code.json "source"). */
	source: string;
	files: ScanFile[];
}

export interface Page {
	path: string;
	title: string;
	text: string;
}

export interface Form {
	file: string;
	action: string;
	fields: string[];
}

export interface ScanResult {
	findings: Finding[];
	/** Facts the classifier and the reviewer see. */
	pages: Page[];
	forms: Form[];
	uiText: string;
	externalHosts: string[];
}

export const severityOf = (risk: number, { reviewAt = 0.4, blockAt = 0.9 } = {}): Severity => (risk >= blockAt ? "block" : risk >= reviewAt ? "review" : "info");

/** Files read as text: markup, code, styles and data. */
export const isText = (type: string, path = ""): boolean =>
	/^(text\/|application\/(javascript|json|xml|manifest\+json|ld\+json)|image\/svg)/.test(type) || /\.(m?js|css|html?|json|svg|txt|webmanifest)$/.test(path);

const BRANDS = [
	"paypal", "apple id", "icloud", "microsoft", "outlook", "office 365", "hotmail", "google account", "gmail", "facebook", "instagram",
	"whatsapp", "netflix", "amazon", "ebay", "dhl", "fedex", "chase bank", "wells fargo", "bank of america", "sparkasse", "volksbank",
	"deutsche bank", "commerzbank", "n26", "revolut", "metamask", "coinbase", "binance", "ledger live", "trezor", "trust wallet",
	"phantom wallet", "roblox", "discord nitro", "online banking",
];
const BRAND_RE = new RegExp(`\\b(${BRANDS.map((b) => b.replace(/ /g, "\\s+")).join("|")})\\b`, "i");
const SEED_RE = /\b(seed|recovery|secret|backup)\s+phrase\b|\bmnemonic\s+(phrase|words)\b|\b(12|24)[- ]word\b|\bprivate\s+key\b/i;
const MINER_RE = /coinhive|coin-hive|cryptonight|cryptoloot|crypto-loot|webminepool|coinimp|xmrig|stratum\+(tcp|ssl):\/\/|minero\.cc|deepminer|webmine\.(cz|pro)/i;
const TRACKERS: [RegExp, string][] = [
	[/google-analytics\.com|googletagmanager\.com|gtag\(\s*['"]config/, "Google Analytics"],
	[/connect\.facebook\.net|facebook\.com\/tr\b|fbq\(\s*['"]init/, "the Facebook pixel"],
	[/static\.hotjar\.com|hotjar\.com\/c\//, "Hotjar"],
	[/cdn\.segment\.com|api\.segment\.io/, "Segment"],
	[/cdn\.mxpnl\.com|api\.mixpanel\.com/, "Mixpanel"],
	[/clarity\.ms\/tag/, "Microsoft Clarity"],
	[/doubleclick\.net|googlesyndication\.com/, "Google ads"],
];
// Hosts that turn an app into a data drop, a tunnel or a code loader.
const RISKY_EGRESS: [RegExp, string][] = [
	[/(^|\.)(pastebin\.com|paste\.ee|hastebin\.com|ghostbin\.\w+|transfer\.sh|file\.io|0x0\.st)$/, "a paste or file-drop service"],
	[/(^|\.)(ngrok\.io|ngrok-free\.app|ngrok\.app|trycloudflare\.com|loca\.lt|serveo\.net|localtunnel\.me)$/, "a tunnel to someone's own machine"],
	[/(^|\.)(webhook\.site|requestbin\.\w+|pipedream\.net|beeceptor\.com|hookbin\.com)$/, "a request collector"],
	[/(^|\.)(discord\.com|discordapp\.com|api\.telegram\.org)$/, "a chat webhook, often used to collect stolen data"],
	[/(^|\.)(ipify\.org|ipinfo\.io|ip-api\.com|ipapi\.co)$/, "an IP address lookup"],
	[/(^|\.)(bit\.ly|tinyurl\.com|t\.co|is\.gd|cutt\.ly)$/, "a link shortener"],
	[/(^|\.)(raw\.githubusercontent\.com|gist\.githubusercontent\.com|cdn\.jsdelivr\.net|unpkg\.com)$/, "a host that serves code, so the app can change after review"],
];
// Hosts that show up in nearly every bundle (namespaces, docs, licenses).
const BORING_HOSTS = /(^|\.)(w3\.org|schema\.org|example\.(com|org|net)|json-schema\.org|svelte\.dev|github\.com|developer\.mozilla\.org|reactjs\.org|react\.dev|vuejs\.org|nuxt\.com|tanstack\.com|mozilla\.org|whatwg\.org|ecma-international\.org|localhost|opensource\.org|npmjs\.com|spdx\.org)$/;

const HOST_RE = /\b(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi;

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

const UI_LITERAL_RE = /"([^"\\\n]{4,160})"|'([^'\\\n]{4,160})'|`([^`\\$]{4,160})`/g;
const NOT_UI_RE = /[{};=]|=>|function\b|\bvar\b|\.prototype|^use strict$|https?:/;

const readableLiteral = (s: string): boolean => /\s/.test(s) && /[a-z]{3}/i.test(s) && !NOT_UI_RE.test(s);
const readableMarkup = (s: string): boolean => /[a-z]{3}\s+[a-z]/i.test(s) && !/[;=]/.test(s);

/** Human-readable strings inside compiled JavaScript: quoted literals with a
 *  space in them and text between tags in template strings. Rough on purpose. */
function uiStrings(js: string): string[] {
	const literals = [...js.matchAll(UI_LITERAL_RE)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter(readableLiteral);
	const markup = [...js.matchAll(/>([^<>{}]{4,160})</g)].map((m) => m[1].trim()).filter(readableMarkup);
	return [...new Set([...literals, ...markup])];
}

const hostsOf = (text: string): string[] => [...new Set([...text.matchAll(HOST_RE)].map((m) => m[1].toLowerCase()))];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const absoluteUrl = (u: string): string => (u.startsWith("//") ? `https:${u}` : u);

function listingFindings(listing: string): Finding[] {
	const brand = BRAND_RE.exec(listing);
	if (!brand) return [];
	return [{ rule: "listing.brand", risk: 0.6, title: `The listing names ${brand[1]}`, detail: "Apps that carry a big brand's name are often impersonations." }];
}

function egressFindings(egress: string[]): Finding[] {
	const out: Finding[] = [];
	for (const host of egress) {
		const risky = RISKY_EGRESS.find(([re]) => re.test(host));
		if (risky) out.push({ rule: "egress.risky", risk: 0.6, title: `Asks to reach ${host}`, detail: `That is ${risky[1]}.` });
	}
	if (egress.length > 5) out.push({ rule: "egress.many", risk: 0.2, title: `Asks to reach ${egress.length} hosts`, detail: egress.join(", ") });
	return out;
}

function parseForm(file: string, attrs: string, body: string): Form {
	const action = /\baction\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "";
	const fields = [...body.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)].map((f) => {
		const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']?([^"'>]+)`, "i").exec(f[2])?.[1] ?? "";
		return [f[1].toLowerCase(), attr("type"), attr("name") || attr("id"), attr("placeholder")].filter(Boolean).join(":");
	});
	return { file, action, fields };
}

function formFindings({ file, action, fields }: Form): Finding[] {
	const external = /^(https?:)?\/\//i.test(action) ? hostsOf(absoluteUrl(action))[0] : null;
	if (!external) return [];
	if (fields.some((f) => /:password\b/.test(f))) {
		return [{ rule: "form.password-elsewhere", risk: 1, title: `Sends a password to ${external}`, detail: `A form with a password field posts to another server (${clip(action, 120)}).`, file }];
	}
	return [{ rule: "form.elsewhere", risk: 0.5, title: `A form posts to ${external}`, detail: "What people type leaves the app for another server.", file }];
}

/** Redirects, remote scripts and frames in one HTML file. */
function markupFindings(file: string, text: string): Finding[] {
	const out: Finding[] = [];
	const refresh = /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]+url\s*=\s*([^"'\s>]+)/i.exec(text)?.[1];
	if (refresh && /^https?:\/\//i.test(refresh)) {
		out.push({ rule: "redirect.away", risk: 0.5, title: `Sends visitors to ${hostsOf(refresh)[0] ?? refresh}`, file });
	}
	for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) {
		const host = hostsOf(absoluteUrl(m[1]))[0];
		out.push({ rule: "script.remote", risk: 0.5, title: `Loads code from ${host}`, detail: "Code from another server can change after review, and that server sees every visitor.", file });
	}
	for (const m of text.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
		out.push({ rule: "frame.remote", risk: 0.4, title: `Embeds ${hostsOf(m[1])[0]}`, file });
	}
	return out;
}

interface HtmlScan {
	pages: Page[];
	forms: Form[];
	ui: string[];
	findings: Finding[];
}

function scanHtml(html: ScanFile[]): HtmlScan {
	const out: HtmlScan = { pages: [], forms: [], ui: [], findings: [] };
	for (const file of html) {
		const text = file.text!;
		const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? "");
		const visible = stripHtml(text);
		out.pages.push({ path: file.path, title, text: clip(visible, 1500) });
		out.ui.push(title, visible);
		for (const m of text.matchAll(/<form\b([^>]*)>([\s\S]*?)(?:<\/form>|$)/gi)) {
			const form = parseForm(file.path, m[1], m[2]);
			out.forms.push(form);
			out.findings.push(...formFindings(form));
		}
		out.findings.push(...markupFindings(file.path, text));
	}
	return out;
}

/** Everything one file of code or markup gives away: miners, trackers,
 *  obfuscation, decoded eval and redirects. */
function codeFindings(file: { path: string; text?: string }): Finding[] {
	const text = file.text ?? "";
	const out: Finding[] = [];
	const miner = MINER_RE.exec(text);
	if (miner) out.push({ rule: "code.miner", risk: 1, title: "Contains a cryptocurrency miner", detail: `Matched “${miner[0]}”.`, file: file.path });
	for (const [re, name] of TRACKERS) {
		if (re.test(text)) out.push({ rule: "code.tracker", risk: 0.5, title: `Tracks visitors with ${name}`, detail: "Store apps keep people's data on their own Hamstr.", file: file.path });
	}
	const hexNames = text.match(/\b_0x[0-9a-f]{4,6}\b/g)?.length ?? 0;
	if (hexNames > 100) out.push({ rule: "code.obfuscated", risk: 0.6, title: "The code is deliberately obfuscated", detail: `${hexNames} _0x… names, the mark of javascript-obfuscator.`, file: file.path });
	if (/\beval\s*\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/.test(text)) {
		out.push({ rule: "code.eval-decoded", risk: 0.7, title: "Runs code it decodes at runtime", detail: "eval() of a decoded string hides what the code does.", file: file.path });
	}
	const away = /\b(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)|location\.(?:replace|assign)\(\s*["'](https?:\/\/[^"']+)/.exec(text);
	if (away && file.path !== "(server code)") out.push({ rule: "redirect.away", risk: 0.5, title: `Sends visitors to ${hostsOf(away[1] ?? away[2])[0]}`, file: file.path });
	return out;
}

const hasPasswordField = (text: string): boolean => /\btype\s*[:=]\s*\\?["']password\\?["']/i.test(text);

function recoveryFindings(shown: string): Finding[] {
	if (!SEED_RE.test(shown)) return [];
	const wallet = /wallet|metamask|ledger|trezor|phantom|coinbase|binance|crypto/i.test(shown);
	return [
		{
			rule: "asks.recovery-phrase",
			risk: wallet ? 0.95 : 0.8,
			title: "Asks about a recovery phrase or private key",
			detail: wallet ? "Together with wallet names, this is the shape of a wallet-draining scam." : "Legitimate apps never need someone's recovery phrase.",
		},
	];
}

// Card fields in a little app are a scam's checkout: store apps have no payments.
function paymentFindings(forms: Form[], everything: { text?: string }[]): Finding[] {
	const cardField = forms.flatMap((f) => f.fields).find((f) => /\b(card|cc-?num|credit|cvc|cvv|iban|expir|security code)/i.test(f));
	if (!cardField && !/autocomplete\s*=\s*\\?["']?cc-(number|csc|exp)/i.test(everything.map((f) => f.text ?? "").join("\n"))) return [];
	return [{ rule: "asks.payment", risk: 0.7, title: "Asks for payment card or bank details", detail: cardField ? `Field: ${cardField}` : "A cc-number, cc-csc or cc-exp field." }];
}

function passwordFindings(password: boolean, brand: string | undefined): Finding[] {
	if (password && brand) return [{ rule: "asks.brand-login", risk: 0.75, title: `Asks for a password and mentions ${brand}`, detail: "The usual shape of a phishing page." }];
	if (password) return [{ rule: "asks.password", risk: 0.1, title: "Has a password field" }];
	return [];
}

export function scanRelease({ manifest, source, files }: ScanInput): ScanResult {
	const findings: Finding[] = [];
	const add = (...found: Finding[]) => {
		// One finding per rule and file is enough to explain it.
		for (const finding of found) {
			if (!findings.some((f) => f.rule === finding.rule && f.file === finding.file)) findings.push(finding);
		}
	};
	const egress: string[] = manifest?.egress ?? [];
	const texts = files.filter((f) => f.text !== undefined);
	const everything = [{ path: "(server code)", text: source }, ...texts];
	const listing = [manifest?.name, manifest?.summary, manifest?.description, manifest?.slug].filter(Boolean).join(" \n");

	add(...listingFindings(listing));
	add(...egressFindings(egress));

	const { pages, forms, ui, findings: pageFindings } = scanHtml(texts.filter((f) => /html/.test(f.type)));
	add(...pageFindings);
	for (const file of texts.filter((f) => /javascript/.test(f.type))) ui.push(...uiStrings(file.text!));
	const uiText = clip([...new Set(ui.filter(Boolean))].join(" · "), 6000);

	// --- code and markup, server and client ---
	for (const file of everything) add(...codeFindings(file));
	const password = everything.some((f) => hasPasswordField(f.text ?? ""));

	// --- what the pages ask people for ---
	const shown = `${uiText} ${listing}`;
	add(...recoveryFindings(shown), ...paymentFindings(forms, everything), ...passwordFindings(password, BRAND_RE.exec(shown)?.[1]));

	const externalHosts = [...new Set(everything.flatMap((f) => hostsOf(f.text ?? "")))].filter((h) => !BORING_HOSTS.test(h) && !egress.includes(h)).slice(0, 40);
	if (externalHosts.length) {
		add({ rule: "hosts.referenced", risk: 0, title: `Mentions ${externalHosts.length} other host${externalHosts.length === 1 ? "" : "s"}`, detail: externalHosts.join(", ") });
	}

	findings.sort((a, b) => b.risk - a.risk);
	return { findings, pages: pages.slice(0, 12), forms: forms.slice(0, 20), uiText, externalHosts };
}
