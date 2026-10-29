// Cubby Shelf UI. No framework, no build step, no token in the browser: the
// shelf server holds the node credentials and this page only calls its own API.
const main = document.getElementById("main");
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const toastEl = document.getElementById("toast");
const countEl = document.getElementById("count");

const state = { config: null, apps: [], installed: [], tab: "store", q: "" };

const h = (tag, props = {}, ...children) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
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

async function api(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
	});
	if (res.status === 401) {
		location.assign("/login");
		throw new Error("signed out");
	}
	const text = await res.text();
	let body = {};
	try {
		body = JSON.parse(text);
	} catch {}
	if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
	return body;
}

const monogram = (app) => (typeof app.icon === "string" && /^[\x20-\x7e]{1,3}$/.test(app.icon) ? app.icon : (app.name || "?").trim().charAt(0).toUpperCase());
const tone = (slug) => [...String(slug)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6;
const icon = (app) => h("div", { class: `icon tone-${tone(app.slug)}`, "aria-hidden": "true", text: monogram(app) });
const tags = (app) => (app.tags ?? []).slice(0, 4).map((t) => h("span", { class: "pill", text: t }));

function toast(text, bad = false) {
	toastEl.textContent = text;
	toastEl.className = `toast ${bad ? "bad" : ""}`;
	toastEl.hidden = false;
	clearTimeout(toastEl._timer);
	toastEl._timer = setTimeout(() => (toastEl.hidden = true), 5000);
}

function closeModal() {
	modal.hidden = true;
	modalBody.replaceChildren();
}

function openModal(...content) {
	modalBody.replaceChildren(
		h("button", { class: "close", type: "button", "aria-label": "Close", text: "×", onclick: closeModal }),
		...content,
	);
	modal.hidden = false;
	modalBody.querySelector("input, select, button.primary")?.focus();
}

function setTab(tab) {
	state.tab = tab;
	for (const button of document.querySelectorAll(".tab")) button.classList.toggle("on", button.dataset.tab === tab);
	if (tab === "store") renderStore();
	else renderInstalled();
}

function card(app, installedHere) {
	return h(
		"article",
		{ class: "card" },
		h("div", { class: "card-label" }, h("span", { text: "from the store" }), h("span", { text: app.slug })),
		h(
			"div",
			{ class: "head" },
			icon(app),
			h("div", {}, h("h3", { text: app.name }), h("div", { class: "dim small", text: `by ${app.publisher}` })),
		),
		h("p", { class: "summary", text: app.summary }),
		h("div", { class: "meta" }, h("span", { class: "pill", text: `v${app.version}` }), tags(app)),
		h(
			"div",
			{ class: "actions" },
			h("a", { class: "link", href: `${state.config.store}/#/app/${app.slug}`, target: "_blank", rel: "noopener", text: "Details" }),
			installedHere
				? h("span", { class: "installed-tag", text: "installed" })
				: h("button", { class: "primary small", type: "button", text: "Install", onclick: () => openInstall(app) }),
		),
	);
}

function renderStore() {
	const search = h("input", {
		type: "search",
		placeholder: "Search little apps…",
		"aria-label": "Search apps",
		value: state.q,
		oninput: (event) => {
			state.q = event.target.value;
			clearTimeout(search._timer);
			search._timer = setTimeout(loadCatalog, 250);
		},
	});
	main.replaceChildren(
		...[
			h("section", { class: "intro" }, h("h1", { text: "Add a little app." }), h("p", { class: "dim", text: "Install from the Cubby store into this node. Data stays in your own SQLite." })),
			h("div", { class: "search" }, search),
			h(
				"div",
				{ class: "grid" },
				state.apps.map((app) => {
					const here = state.installed.some((entry) => entry.slug === app.slug);
					return card(app, here);
				}),
			),
			state.apps.length ? null : h("p", { class: "dim", text: "No apps match." }),
		].filter(Boolean),
	);
}

function renderInstalled() {
	main.replaceChildren(
		h("section", { class: "intro" }, h("h1", { text: "Installed" }), h("p", { class: "dim", text: "Apps on this node. Updating keeps their Durable Object data." })),
		state.installed.length
			? h(
					"div",
					{ class: "list" },
					state.installed.map((entry) =>
						h(
							"article",
							{ class: "row" },
							icon({ name: entry.name || entry.slug, slug: entry.slug, icon: entry.icon }),
							h(
								"div",
								{ class: "grow" },
								h("h3", { text: entry.name || entry.slug }),
								h("div", { class: "dim small" }, `${entry.host} · v${entry.version}`, entry.egress?.length ? ` · network: ${entry.egress.join(", ")}` : " · no network"),
							),
							entry.updateAvailable ? h("span", { class: "pill update", text: `v${entry.latest} available` }) : null,
							h(
								"div",
								{ class: "actions" },
								h("a", { class: "link", href: `${state.config.appScheme}://${entry.host}`, target: "_blank", rel: "noopener", text: "Open" }),
								entry.updateAvailable
									? h("button", {
											class: "primary small",
											type: "button",
											text: "Update",
											onclick: () => openInstall({ slug: entry.slug, name: entry.name || entry.slug, summary: entry.summary || "" }, { host: entry.host, version: entry.latest, update: true }),
										})
									: null,
								h("button", {
									class: "ghost small danger",
									type: "button",
									text: "Remove",
									onclick: async () => {
										const typed = prompt(`Remove ${entry.slug} and all of its data from ${entry.host}?\n\nType the hostname to confirm:`);
										if (typed !== entry.host) return;
										try {
											await api("/api/remove", { method: "POST", body: JSON.stringify({ host: entry.host, confirm: typed }) });
											toast(`${entry.slug} removed from ${entry.host}`);
											await loadInstalled();
										} catch (err) {
											toast(err.message, true);
										}
									},
								}),
							),
						),
					),
				)
			: h("div", { class: "empty" }, h("p", { text: "Nothing installed yet." }), h("button", { class: "primary", type: "button", text: "Browse the store", onclick: () => setTab("store") })),
	);
}

async function openInstall(app, options = {}) {
	const detail = await api(`/api/apps/${app.slug}`);
	const releases = detail.releases.filter((r) => r.status === "published");
	if (!releases.length) return toast("No published release.", true);
	const chosen = options.version ? releases.find((r) => r.version === options.version) : releases[0];
	if (!chosen) return toast("That version is not published.", true);
	const prior = state.installed.find((entry) => entry.host === options.host);
	const host = options.host ?? `celld-${app.slug}.${state.config.appDomain}`;
	const egress = chosen.manifest?.egress ?? [];
	const already = new Set(prior?.egress ?? []);

	const hostInput = h("input", { name: "host", value: host, readonly: Boolean(options.host), required: true, spellcheck: "false" });
	const versionSelect = h("select", { name: "version" }, releases.map((r) => h("option", { value: r.version, selected: r.version === chosen.version, text: `v${r.version}${r.version === releases[0].version ? " (latest)" : ""}` })));
	const allow = h("input", { type: "checkbox", id: "allow", checked: egress.every((h) => already.has(h)) && egress.length > 0 });
	const replace = h("input", { type: "checkbox", id: "replace" });
	const log = h("pre", { class: "log", hidden: true });
	const submit = h("button", { class: "primary", type: "submit", text: options.update ? "Update" : "Install" });

	const form = h(
		"form",
		{
			class: "install-form",
			onsubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				submit.textContent = "Installing…";
				log.hidden = false;
				log.textContent = "Downloading, verifying and deploying…";
				try {
					const result = await api("/api/install", {
						method: "POST",
						body: JSON.stringify({
							slug: app.slug,
							version: versionSelect.value,
							host: hostInput.value.trim(),
							allowEgress: egress.length ? allow.checked : true,
							replace: replace.checked,
						}),
					});
					log.textContent = result.output || "Installed.";
					toast(`${app.name} ${result.installed?.version ? `v${result.installed.version} ` : ""}installed`);
					await loadInstalled();
					setTab("installed");
					setTimeout(closeModal, 900);
				} catch (err) {
					log.textContent = err.message;
					toast(err.message, true);
					submit.disabled = false;
					submit.textContent = options.update ? "Update" : "Install";
				}
			},
		},
		h("h2", { id: "modalTitle", text: `${options.update ? "Update" : "Install"} ${app.name}` }),
		h("p", { class: "dim", text: app.summary || "" }),
		options.update
			? null
			: h("p", { class: "dim", text: "Heads up: this app runs on the same celld node as your own sites. It cannot read their data, but it shares the process, memory and disk, so only install apps you trust." }),
		h("label", { class: "field" }, h("span", { text: "Site hostname" }), hostInput),
		h("label", { class: "field" }, h("span", { text: "Version" }), versionSelect),
		h(
			"div",
			{ class: "perm" },
			h("strong", { text: "Network" }),
			egress.length
				? h(
						"div",
						{},
						h("div", { text: "This app may fetch:" }),
						h("ul", { class: "hosts" }, egress.map((name) => h("li", { class: "mono", text: name }))),
						h("label", { class: "check" }, allow, h("span", { text: "Allow this network access" })),
					)
				: h("div", { class: "ok", text: "No network access. All data stays on this node." }),
		),
		prior && prior.slug !== app.slug
			? h(
					"div",
					{ class: "warn" },
					h("strong", { text: `${host} already runs ${prior.slug}.` }),
					h("p", { text: `Installing ${app.slug} there gives it access to ${prior.slug}'s Durable Objects and data. Use a new hostname, or confirm:` }),
					h("label", { class: "check" }, replace, h("span", { text: "Replace the existing app" })),
				)
			: null,
		h("div", { class: "row-actions" }, h("button", { class: "ghost", type: "button", text: "Cancel", onclick: closeModal }), submit),
		log,
	);
	openModal(form);
}

async function loadCatalog() {
	const params = new URLSearchParams({ limit: "100" });
	if (state.q) params.set("q", state.q);
	const body = await api(`/api/catalog?${params}`);
	state.apps = body.apps;
	if (state.tab === "store") renderStore();
}

async function loadInstalled() {
	const body = await api("/api/installed");
	state.installed = body.installed;
	countEl.textContent = state.installed.length ? String(state.installed.length) : "";
	countEl.hidden = state.installed.length === 0;
	if (state.tab === "installed") renderInstalled();
}

async function boot() {
	for (const button of document.querySelectorAll(".tab")) {
		button.addEventListener("click", () => setTab(button.dataset.tab));
	}
	modal.addEventListener("click", (event) => {
		if (event.target === modal) closeModal();
	});
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeModal();
	});
	try {
		state.config = await api("/api/config");
		await Promise.all([loadCatalog(), loadInstalled()]);
		setTab("store");
	} catch (err) {
		if (err.message !== "signed out") {
			main.replaceChildren(h("p", { class: "error", text: err.message }));
		}
	}
}

boot();
