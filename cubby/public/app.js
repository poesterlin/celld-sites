// Cubby catalog UI: no framework, no build step. Everything from the API is
// untrusted: text goes through textContent, links only through http(s) values
// the server already validated.
const main = document.getElementById("main");
const state = { q: "", tag: "", apps: [], tags: new Set(), request: 0 };

const el = (tag, props = {}, ...children) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, String(value));
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
};

const api = async (path, options = {}) => {
	const res = await fetch(path, {
		...options,
		headers: {
			accept: "application/json",
			...(options.body ? { "content-type": "application/json" } : {}),
			...(options.headers ?? {}),
		},
	});
	let body = {};
	try {
		body = await res.json();
	} catch {}
	if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
	return body;
};

// Emoji need an emoji font on the viewer's machine; a store should not depend
// on one. Any printable ASCII icon is shown as-is, everything else becomes a
// deterministic monogram ("W" for Wichteln).
const iconOf = (app) => (typeof app.icon === "string" && /^[\x20-\x7e]{1,3}$/.test(app.icon) ? app.icon : (app.name || "?").trim().charAt(0).toUpperCase());
const toneOf = (slug) => [...String(slug)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6;
const iconNode = (app) => el("div", { class: `icon tone-${toneOf(app.slug)}`, "aria-hidden": "true", text: iconOf(app) });

const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const shortSha = (sha) => (sha ? `${sha.slice(0, 12)}…` : "");
const installCommand = (slug) => `cubby install ${slug} \\\n  --store ${location.origin} \\\n  --host <your-app-host>`;

function notice(text) {
	return el("p", { class: "notice", text });
}

function card(app) {
	return el(
		"a",
		{ class: "card", href: `#/app/${app.slug}` },
		el("div", { class: "card-label" }, el("span", { class: "card-no" }), el("span", { text: app.slug })),
		el(
			"div",
			{ class: "card-body" },
			el(
				"div",
				{ class: "head" },
				iconNode(app),
				el("div", {}, el("h3", { text: app.name }), el("div", { class: "dim small", text: `by ${app.publisher}` })),
			),
			el("p", { class: "summary", text: app.summary }),
			el(
				"div",
				{ class: "meta" },
				el("span", { class: "pill", text: `v${app.version}` }),
				app.tags.slice(0, 3).map((tag) => el("span", { class: "pill", text: tag })),
				el("span", { text: `${app.downloads} install${app.downloads === 1 ? "" : "s"}` }),
			),
		),
		el("div", { class: "card-foot" }, el("span", { text: app.license }), el("span", { class: "open", text: "Open →" })),
	);
}

function chipRow() {
	return el(
		"div",
		{ class: "chips", role: "group", "aria-label": "Filter by tag" },
		["all", ...[...state.tags].sort()].map((tag) =>
			el("button", {
				class: "chip",
				type: "button",
				"aria-pressed": String(tag === "all" ? state.tag === "" : state.tag === tag),
				text: tag,
				onclick: () => {
					state.tag = tag === "all" ? "" : tag;
					home.chips.replaceChildren(chipRow());
					loadResults();
				},
			}),
		),
	);
}

const home = {};

function shelfArt() {
	const boxes = [
		["01", "S", "red"],
		["02", "W", "olive"],
		["03", "", ""],
		["04", "", ""],
		["05", "", ""],
		["06", "", ""],
	];
	return el(
		"div",
		{ class: "shelf-art", "aria-hidden": "true" },
		el("div", { class: "shelf-head" }, el("span", { text: "SHELF 01" }), el("span", {}, el("b", { text: "OPEN" }), " / LOCAL")),
		el(
			"div",
			{ class: "shelf-grid" },
			boxes.map(([no, letter, tone]) =>
				el(
					"div",
					{ class: `shelf-box ${letter ? `filled ${tone}` : ""}` },
					el("span", { class: "no", text: no }),
					letter ? el("span", { class: "letter", text: letter }) : null,
				),
			),
		),
		el("div", { class: "shelf-foot" }, el("span", { text: "02 / 06 OCCUPIED" }), el("span", { text: "CUBBY" })),
	);
}

function renderHome() {
	const search = el("input", {
		type: "search",
		placeholder: "Search little apps…",
		"aria-label": "Search apps",
		value: state.q,
		oninput: (event) => {
			state.q = event.target.value;
			clearTimeout(search._timer);
			search._timer = setTimeout(loadResults, 250);
		},
	});
	home.chips = el("div", {}, chipRow());
	home.results = el("div", { class: "grid" });
	home.count = el("p", { class: "count-line" });
	main.replaceChildren(
		el(
			"section",
			{ class: "hero" },
			el(
				"div",
				{},
				el("div", { class: "kicker", text: "Little apps, on your own machine" }),
				el("h1", {}, "Little tools,", el("br"), "in their own ", el("em", { text: "cubby" })),
				el(
					"p",
					{ class: "lead" },
					"Single-purpose web apps you install into your own sandboxed celld node. No account to use them, no idle RAM, and every byte of data stays in local SQLite.",
				),
				el(
					"div",
					{ class: "hero-facts" },
					el("span", { text: "No accounts" }),
					el("span", { text: "Local SQLite" }),
					el("span", { text: "Sandboxed" }),
				),
			),
			shelfArt(),
		),
		el("div", { class: "search" }, el("label", { class: "search-label", text: "Search the shelf" }), search),
		home.chips,
		home.results,
		home.count,
	);
}

async function loadResults() {
	const seq = ++state.request;
	home.results.replaceChildren(el("p", { class: "loading", text: "Looking through the cubbies…" }));
	home.count.replaceChildren();
	try {
		const params = new URLSearchParams({ limit: "60" });
		if (state.q) params.set("q", state.q);
		if (state.tag) params.set("tag", state.tag);
		const body = await api(`/api/v1/apps?${params}`);
		if (seq !== state.request) return;
		state.apps = body.apps;
		body.apps.forEach((app) => app.tags.forEach((tag) => state.tags.add(tag)));
		home.results.replaceChildren(...(body.apps.length ? body.apps.map(card) : [el("p", { class: "dim", text: "No apps match. Try another word, or publish one." })]));
		home.count.replaceChildren(
			`SHELF · ${body.total} APP${body.total === 1 ? "" : "S"}  `,
			el("a", { href: "#/publish", text: "Publish one →" }),
		);
		home.chips.replaceChildren(chipRow());
	} catch (err) {
		if (seq !== state.request) return;
		home.results.replaceChildren(el("p", { class: "error", text: err.message }));
		home.count.replaceChildren(el("a", { href: "#/publish", text: "Publish the first app" }));
	}
}

function copyButton(text) {
	const button = el("button", { class: "copy", type: "button", text: "Copy" });
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
			setTimeout(() => (button.textContent = "Copy"), 1500);
		} catch {
			button.textContent = "Select the command";
		}
	});
	return button;
}

function permissionPanel(app) {
	const network = app.releases?.[0]?.manifest?.egress ?? [];
	return el(
		"div",
		{ class: "perms" },
		el(
			"div",
			{ class: "perm" },
			el("strong", { text: "Network" }),
			network.length
				? el("div", {}, "May fetch only: ", el("span", { class: "mono", text: network.join(", ") }))
				: el("div", { class: "ok", text: "No network access" }),
		),
		el(
			"div",
			{ class: "perm" },
			el("strong", { text: "Data" }),
			el("div", { text: "Own SQLite database per Durable Object, inside your celld node." }),
		),
		el(
			"div",
			{ class: "perm" },
			el("strong", { text: "Secrets" }),
			el("div", { text: "None. An app that needs an API key does not belong in Cubby yet." }),
		),
	);
}

let demoTimer = null;
const narrowDemo = () => window.matchMedia("(max-width: 760px)").matches;
const stopDemoClock = () => {
	if (demoTimer) clearInterval(demoTimer);
	demoTimer = null;
};

async function startDemo(app, button) {
	const label = button.textContent;
	button.disabled = true;
	button.textContent = "Starting sandbox…";
	try {
		const session = await api(`/api/v1/apps/${app.slug}/demo`, { method: "POST", body: "{}" });
		if (session.endToken) sessionStorage.setItem(`cubby-demo-${session.id}`, session.endToken);
		location.hash = `#/demo/${session.id}`;
	} catch (err) {
		alert(err.message);
		button.disabled = false;
		button.textContent = label;
	}
}

function demoClock(left, expiresAt, id) {
	const update = () => {
		const ms = new Date(expiresAt).getTime() - Date.now();
		if (ms <= 0) {
			left.textContent = "Ended";
			left.classList.add("error");
			sessionStorage.removeItem(`cubby-demo-${id}`);
			return;
		}
		const m = Math.floor(ms / 60000);
		const sec = Math.floor((ms % 60000) / 1000);
		left.textContent = `${m}:${String(sec).padStart(2, "0")} left`;
	};
	update();
	stopDemoClock();
	demoTimer = setInterval(update, 1000);
}

async function renderDemo(id) {
	stopDemoClock();
	document.body.classList.remove("demo-mode");
	main.replaceChildren(el("p", { class: "loading", text: "Opening the sandbox…" }));
	let demo;
	try {
		demo = await api(`/api/v1/demos/${encodeURIComponent(id)}`);
	} catch (err) {
		main.replaceChildren(
			el("p", { class: "error", text: err.message }),
			el("p", {}, el("a", { href: "#/", text: "← Back to all apps" })),
		);
		return;
	}
	const appSlug = demo.app?.slug;
	const appName = demo.app?.name ?? "this app";
	const back = appSlug ? `#/app/${appSlug}` : "#/";
	if (demo.status === "expired" || new Date(demo.expiresAt).getTime() <= Date.now()) {
		main.replaceChildren(
			el("p", {}, el("a", { href: back, text: "← Back to the app" })),
			el(
				"div",
				{ class: "panel" },
				el("h1", { text: "This demo has ended" }),
				el("p", { class: "dim", text: "Demo sessions last 15 minutes and are deleted afterwards. Start a fresh one from the app page." }),
				el("p", {}, el("a", { href: back, text: "Start another demo" })),
			),
		);
		return;
	}
	document.body.classList.add("demo-mode");
	const left = el("span", { class: "demo-left" });
	const endToken = sessionStorage.getItem(`cubby-demo-${id}`);
	const end = endToken
		? el("button", {
				class: "chip",
				type: "button",
				text: "End demo",
				onclick: async () => {
					end.disabled = true;
					end.textContent = "Ending…";
					try {
						await api(`/api/v1/demos/${id}`, { method: "DELETE", headers: { "x-demo-token": endToken } });
					} catch {}
					sessionStorage.removeItem(`cubby-demo-${id}`);
					location.hash = back;
				},
			})
		: el("span", { class: "dim small", text: "Ends automatically" });
	const stage = narrowDemo()
		? el(
				"div",
				{ class: "demo-handoff" },
				el("p", { class: "kicker", text: "Sandbox ready" }),
				el("h1", { text: `Try ${appName} full screen` }),
				el(
					"p",
					{ class: "dim" },
					"On a phone, the app opens in its own tab so forms, the keyboard and scrolling behave like the real thing. Close that tab to come back here.",
				),
				el("a", { class: "copy", href: demo.url, target: "_blank", rel: "noopener", text: "Open the demo" }),
				el("p", { class: "dim small", text: "The session is temporary and ends automatically; its data is deleted afterwards." }),
			)
		: el("iframe", {
				class: "demo-frame",
				src: demo.url,
				title: `${appName} demo`,
				sandbox: "allow-scripts allow-forms allow-same-origin allow-popups allow-downloads",
				allow: "clipboard-write",
			});
	main.replaceChildren(
		el(
			"section",
			{ class: "demo-page" },
			el(
				"header",
				{ class: "demo-top" },
				el("a", { class: "demo-back", href: back, "aria-label": "Back to the app", text: "←" }),
				el("div", { class: "demo-heading" }, el("strong", { text: `Try ${appName}` }), el("span", { class: "dim", text: "Temporary sandbox" })),
				el(
					"div",
					{ class: "demo-actions" },
					left,
					el("a", { class: "demo-link", href: demo.url, target: "_blank", rel: "noopener", text: "New tab" }),
					end,
				),
			),
			el("div", { class: "demo-stage" }, stage),
		),
	);
	demoClock(left, demo.expiresAt, id);
}

async function renderApp(slug) {
	main.replaceChildren(el("p", { class: "loading", text: "Opening cubby…" }));
	let body;
	try {
		body = await api(`/api/v1/apps/${encodeURIComponent(slug)}`);
	} catch (err) {
		main.replaceChildren(
			el("p", { class: "error", text: err.message }),
			el("p", {}, el("a", { href: "#/", text: "← Back to all apps" })),
		);
		return;
	}
	const { app, releases } = body;
	const latest = releases.find((r) => r.status === "published") ?? releases[0];
	const manifest = latest?.manifest ?? {};
	const command = installCommand(app.slug);
	main.replaceChildren(
		el("p", {}, el("a", { href: "#/", text: "← All apps" })),
		el("div", { class: "entry-label" }, el("span", {}, "ENTRY / ", el("b", { text: app.slug })), el("span", { text: `v${app.version} · ${app.license}` })),
		el(
			"section",
			{ class: "detail-head" },
			iconNode(app),
			el(
				"div",
				{},
				el("h1", { text: app.name }),
				el("p", { class: "summary", text: app.summary }),
				el(
					"div",
					{ class: "detail-meta" },
					el("span", { class: "pill", text: `v${app.version}` }),
					el("span", { class: "pill", text: `by ${app.publisher}` }),
					el("span", { class: "pill", text: app.license }),
					el("span", { class: "pill", text: `${app.downloads} install${app.downloads === 1 ? "" : "s"}` }),
				),
			),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "Install" }),
			el(
				"p",
				{ class: "dim" },
				"Run this on the machine that hosts your celld node. Cubby downloads the bundle, verifies its SHA-256, shows the permissions, and deploys it as a site.",
			),
			el("div", { class: "install" }, el("pre", {}, el("code", { text: command })), copyButton(command)),
			manifest.egress?.length ? notice("This app declares network access. The installer asks before granting it.") : null,
		),
		body.demo?.enabled
			? el(
					"div",
					{ class: "panel" },
					el("h2", { text: "Try it live" }),
					body.demo.available
						? el(
								"div",
								{ class: "install" },
								el("p", { class: "dim", text: "Start a temporary, isolated copy on the store's demo node. No account, no impact on your node; it is deleted automatically." }),
								el("button", { class: "copy", type: "button", text: "Start demo", onclick: (event) => startDemo(app, event.currentTarget) }),
							)
						: el("p", { class: "dim", text: body.demo.reason || "This app cannot be demoed." }),
				)
			: null,
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "What it can do" }),
			permissionPanel({ ...app, releases }),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "About this app" }),
			el("p", { class: "desc", text: app.description || "No description." }),
			app.homepage ? el("p", {}, "Homepage: ", el("a", { href: app.homepage, rel: "noopener noreferrer", text: app.homepage })) : null,
			app.source ? el("p", {}, "Source: ", el("a", { href: app.source, rel: "noopener noreferrer", text: app.source })) : null,
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "Releases" }),
			el(
				"div",
				{ class: "releases" },
				releases.map((release) =>
					el(
						"div",
						{ class: "release" },
						el("div", {}, el("strong", { text: release.version }), release.status !== "published" ? el("span", { class: "pill", text: release.status }) : null),
						el("div", { class: "dim", text: `${shortDate(release.publishedAt || release.createdAt)} · ${release.bundleSize ? `${(release.bundleSize / 1024 / 1024).toFixed(1)} MiB` : "no bundle"} · sha ${shortSha(release.bundleSha256)}` }),
						release.status === "published"
							? el("a", { href: `/api/v1/apps/${app.slug}/releases/${encodeURIComponent(release.version)}/download`, text: "Download" })
							: null,
					),
				),
			),
			el(
				"p",
				{ class: "dim" },
				"Found a problem? ",
				el("button", {
					class: "chip",
					type: "button",
					text: "Report this release",
					onclick: async () => {
						const reason = prompt("What is wrong with this release? (5–1000 characters)");
						if (!reason) return;
						try {
							const res = await fetch(`/api/v1/apps/${app.slug}/releases/${latest.version}/report`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ reason }),
							});
							const answer = await res.json().catch(() => ({}));
							alert(res.ok ? "Report sent to the store operator." : answer.error || "Could not send the report.");
						} catch {
							alert("Could not reach the store.");
						}
					},
				}),
			),
		),
	);
}

function renderAbout() {
	main.replaceChildren(
		el("p", {}, el("a", { href: "#/", text: "← All apps" })),
		el("h1", { text: "How Cubby works" }),
		el(
			"p",
			{ class: "lead" },
			"A catalog for the kind of software that is too small for Docker and too personal for someone else’s cloud.",
		),
		el(
			"div",
			{ class: "steps" },
			el("div", { class: "step" }, el("h3", { text: "The store is just a shelf" }), el("p", { text: "It holds metadata, a packed bundle and its SHA-256. It never builds or runs an app, and it has no access to your node." })),
			el("div", { class: "step" }, el("h3", { text: "You install into your node" }), el("p", { text: "The cubby CLI verifies the bundle, shows the permissions, sets the egress allowlist only with consent, and deploys through your existing push.sh + deploy check." })),
			el("div", { class: "step" }, el("h3", { text: "The sandbox holds" }), el("p", { text: "Each app is a V8 isolate with its own Durable Objects and SQLite. No filesystem, no secrets, no network unless listed. Data lives on your machine." })),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "What “install” actually does" }),
			el(
				"ol",
				{},
				el("li", { text: "Downloads the release from this catalog and checks its SHA-256." }),
				el("li", { text: "Re-validates every blob hash, path and size before the bundle reaches your node." }),
				el("li", { text: "Shows declared network hosts; without --allow-egress it asks you interactively." }),
				el("li", { text: "Pushes the bundle to your celld node, which runs the deploy check in a scratch isolate." }),
				el("li", { text: "Records the installed version in ~/.config/cubby/installed.json." }),
			),
			el("p", { class: "dim", text: "Updating keeps the app's Durable Object data: data belongs to the site id, not the version." }),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "Trust model" }),
			el("ul", {}, [
				"The store operator sees every bundle and can remove releases; publishing does not make code private.",
				"Apps are not signed yet. The bundle hash protects transport integrity, not authorship.",
				"The celld isolate is the security boundary: egress is opt-in, CPU is capped per request, and storage is local.",
				"For a public store, run review mode and treat unreviewed uploads as hostile.",
			].map((text) => el("li", { text }))),
		),
	);
}

function renderPublish() {
	const origin = location.origin;
	main.replaceChildren(
		el("p", {}, el("a", { href: "#/", text: "← All apps" })),
		el("h1", { text: "Publish a little app" }),
		el(
			"p",
			{ class: "lead" },
			"Build it locally with the normal celld tooling, add a cubby.json, and upload the packed bundle. The store never runs your build.",
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "1. Create a publisher" }),
			el("pre", { class: "block" }, el("code", { text: `cubby register your-name --store ${origin}\ncubby login your-name --store ${origin}` })),
			el("p", { class: "dim", text: "The token is stored in ~/.config/cubby/config.json (mode 600). There is no email and no password reset yet." }),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "2. Describe the app" }),
			el("p", {}, "Add ", el("code", { text: "cubby.json" }), " next to the site's celld.json:"),
			el(
				"pre",
				{ class: "block" },
				el("code", {
					text: JSON.stringify(
						{
							schema: 1,
							name: "Secret Santa",
							summary: "Draw names without an account.",
							description: "Add names, draw once, share the result.",
							version: "1.0.0",
							license: "MIT",
							icon: "🎁",
							tags: ["family", "fun"],
							egress: [],
						},
						null,
						2,
					),
				}),
			),
			el("p", { class: "dim", text: "egress is the only permission an app can request. Everything else is sandboxed by default." }),
		),
		el(
			"div",
			{ class: "panel" },
			el("h2", { text: "3. Publish" }),
			el("pre", { class: "block" }, el("code", { text: `cubby publish ./my-app --store ${origin}` })),
			el("p", { class: "dim", text: "The CLI builds (unless --no-build), packs with tools/pack.mjs, validates the bundle locally, then uploads it. A version can never be replaced." }),
			el("p", { class: "dim", text: "New releases may wait for operator review before they appear in the catalog." }),
		),
	);
}

function route() {
	stopDemoClock();
	document.body.classList.remove("demo-mode");
	const hash = location.hash || "#/";
	if (hash.startsWith("#/demo/")) {
		const id = hash.slice("#/demo/".length);
		if (/^[a-f0-9]{12}$/.test(id)) renderDemo(id);
		else location.hash = "#/";
	} else if (hash.startsWith("#/app/")) {
		const slug = decodeURIComponent(hash.slice("#/app/".length));
		renderApp(slug);
	} else if (hash === "#/about") renderAbout();
	else if (hash === "#/publish") renderPublish();
	else {
		renderHome();
		loadResults();
	}
}

window.addEventListener("hashchange", route);
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", route, { once: true });
else route();
