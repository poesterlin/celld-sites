// Hamstr shell UI: a small framework-free SPA. Every string from the server is
// escaped before it reaches innerHTML.
const main = document.getElementById("main");
const bar = document.getElementById("bar");
const scrim = document.getElementById("scrim");
const sheet = document.getElementById("sheet");
const toastEl = document.getElementById("toast");

const esc = (value) =>
	String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
	back: svg('<path d="M15 18l-6-6 6-6"/>'),
	share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>'),
	external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
	more: svg('<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>'),
	people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6c2.4-.2 4.2 1.2 5 3.9"/>'),
	close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
	copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
};
const COLORS = ["c-sun", "c-leaf", "c-sky", "c-rose", "c-sand", "c-lilac"];
const colorFor = (key) => COLORS[[...String(key)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const iconTile = (app, extra = "") => `<span class="tile-icon ${colorFor(app.slug)} ${extra}">${esc(app.icon || "▫")}</span>`;

function timeAgo(iso) {
	if (!iso) return "never opened";
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 86400 * 300 ? "numeric" : undefined });
}

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let data = {};
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		if (res.status === 401) welcome();
		throw new ApiError(res.status, data.error || `Something went wrong (${res.status})`);
	}
	return data;
}

let toastTimer;
function toast(message, error = false) {
	toastEl.textContent = message;
	toastEl.className = `toast${error ? " error" : ""}`;
	toastEl.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toastEl.hidden = true), error ? 6000 : 3200);
}
// A 401 already switched to the sign-in screen; nothing to report.
const oops = (err) => err?.status !== 401 && toast(err?.message ?? String(err), true);

function openSheet(html, label) {
	sheet.innerHTML = html;
	sheet.setAttribute("aria-label", label);
	scrim.hidden = false;
	(sheet.querySelector("[autofocus]") ?? sheet.querySelector("button, input"))?.focus();
	return sheet;
}
function closeSheet() {
	scrim.hidden = true;
	sheet.innerHTML = "";
}
scrim.addEventListener("click", (e) => e.target === scrim && closeSheet());
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		if (!scrim.hidden) closeSheet();
		closeMenus();
	}
});
const sheetHead = (title, sub = "") => `<div class="sheet-head"><div><h2>${title}</h2>${sub ? `<p class="dim small sheet-sub">${sub}</p>` : ""}</div>
	<button type="button" class="icon-button" data-close aria-label="Close">${ICON.close}</button></div>`;
sheet.addEventListener("click", (e) => e.target.closest("[data-close]") && closeSheet());

// --- menus -------------------------------------------------------------------
function closeMenus() {
	document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
	document.querySelectorAll("[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}
document.addEventListener("click", (e) => {
	const toggle = e.target.closest("[aria-haspopup='menu']");
	if (toggle) {
		const menu = toggle.nextElementSibling;
		const open = menu.hidden;
		closeMenus();
		menu.hidden = !open;
		toggle.setAttribute("aria-expanded", String(open));
		return;
	}
	if (!e.target.closest(".menu")) closeMenus();
});

// --- routing -----------------------------------------------------------------
let me = null;
document.addEventListener("click", (e) => {
	const link = e.target.closest("a[data-link]");
	if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
	e.preventDefault();
	navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", route);
window.addEventListener("scroll", () => bar.classList.toggle("scrolled", window.scrollY > 4), { passive: true });
function navigate(path) {
	if (path !== location.pathname) history.pushState(null, "", path);
	route();
}
function route() {
	closeSheet();
	closeMenus();
	const path = location.pathname;
	const grain = /^\/g\/([a-z0-9]{12})$/.exec(path);
	document.body.classList.toggle("grain-mode", Boolean(grain));
	bar.hidden = Boolean(grain);
	const tab = grain ? "" : path === "/" ? "home" : path.slice(1);
	bar.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
	window.scrollTo(0, 0);
	if (grain) return grainView(grain[1]).catch(oops);
	document.title = "Hamstr";
	if (path === "/shared") return sharedPage().catch(oops);
	if (path === "/apps") return appsPage().catch(oops);
	if (path === "/trash") return trashPage().catch(oops);
	return homePage().catch(oops);
}

// --- pages -------------------------------------------------------------------
function welcome() {
	bar.hidden = true;
	document.body.classList.remove("grain-mode");
	const next = location.pathname + location.search;
	main.innerHTML = `<div class="welcome"><div class="welcome-card">
		<img src="/favicon.svg" alt="">
		<h1>Hamstr</h1>
		<p class="dim tagline">Your little apps, and everything you make with them, tucked safely into your own burrow.</p>
		<div class="stack"><a class="button" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with Tailscale</a></div>
	</div></div>`;
}

function greeting() {
	const h = new Date().getHours();
	const first = esc((me.user.name ?? "").split(" ")[0]);
	return `${h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}${first ? `, ${first}` : ""}`;
}

function tile(g, { shared = false } = {}) {
	const meta = shared ? esc(g.owner.name) : esc(g.app.name);
	const hint = shared ? `${g.app.name}, shared by ${g.owner.name}` : `${g.app.name}, opened ${timeAgo(g.openedAt ?? g.createdAt)}`;
	return `<a class="tile" href="/g/${g.id}" data-link title="${esc(hint)}">
		${iconTile(g.app)}
		<span class="tile-title">${esc(g.title)}</span>
		<span class="tile-meta">${meta}</span>
		${g.shared ? `<span class="tile-badge" title="Shared">${ICON.people}</span>` : ""}
	</a>`;
}

async function homePage() {
	const { mine } = await api("/api/grains");
	main.innerHTML = `<div class="page">
		<div class="page-head"><div><p class="dim small eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p><h1>${greeting()}</h1><p class="dim">${mine.length ? `${mine.length} grain${mine.length === 1 ? "" : "s"} in your burrow.` : "Your burrow is empty, for now."}</p></div>
		<button type="button" class="button" data-new>+ New</button></div>
		<div class="tiles">
			<button type="button" class="tile new" data-new><span class="plus">+</span><span>New grain</span></button>
			${mine.map((g) => tile(g)).join("")}
		</div>
		${mine.length ? "" : `<p class="dim small hint">A <strong>grain</strong> is one thing you make with an app: a board, a list, a draw. Each one keeps its own data and can be shared on its own.</p>`}
	</div>`;
	main.querySelectorAll("[data-new]").forEach((b) => b.addEventListener("click", () => newGrain().catch(oops)));
}

async function sharedPage() {
	const { shared } = await api("/api/grains");
	main.innerHTML = `<div class="page">
		<div class="page-head"><div><h1>Shared with you</h1><p class="dim">Grains other people opened up for you.</p></div></div>
		${
			shared.length
				? `<div class="tiles">${shared.map((g) => tile(g, { shared: true })).join("")}</div>`
				: `<div class="empty"><img src="/favicon.svg" alt=""><h2>Nothing here yet</h2><p>When someone sends you a Hamstr link and you sign in, it shows up here.</p></div>`
		}
	</div>`;
}

async function trashPage() {
	const { trash } = await api("/api/grains");
	main.innerHTML = `<div class="page">
		<div class="page-head"><div><h1>Trash</h1><p class="dim">Grains here are deleted for good after 30 days. Nobody can open them meanwhile.</p></div></div>
		${
			trash.length
				? `<div class="rows">${trash
						.map(
							(g) => `<div class="row" data-id="${g.id}">${iconTile(g.app)}
						<div class="grow"><strong>${esc(g.title)}</strong><div class="dim small">${esc(g.app.name)} · trashed ${timeAgo(g.trashedAt)}</div></div>
						<button type="button" class="button ghost small" data-restore>Restore</button>
						<button type="button" class="button danger small" data-delete>Delete forever</button></div>`,
						)
						.join("")}</div>`
				: `<div class="empty"><h2>The trash is empty</h2><p>Nice and tidy.</p></div>`
		}
	</div>`;
	main.querySelectorAll(".row").forEach((row) => {
		const id = row.dataset.id;
		row.querySelector("[data-restore]").addEventListener("click", async () => {
			try {
				await api(`/api/grains/${id}/restore`, { method: "POST", body: {} });
				toast("Restored");
				trashPage();
			} catch (err) {
				oops(err);
			}
		});
		row.querySelector("[data-delete]").addEventListener("click", () => {
			const title = row.querySelector("strong").textContent;
			openSheet(
				`${sheetHead("Delete forever?")}<p>“${esc(title)}” and all of its data will be erased. This can't be undone.</p>
				<div class="sheet-foot"><button type="button" class="button ghost" data-close>Keep it</button><button type="button" class="button" data-confirm>Delete forever</button></div>`,
				"Delete grain",
			);
			sheet.querySelector("[data-confirm]").addEventListener("click", async (e) => {
				e.target.disabled = true;
				try {
					await api(`/api/grains/${id}`, { method: "DELETE" });
					closeSheet();
					toast("Deleted");
					trashPage();
				} catch (err) {
					e.target.disabled = false;
					oops(err);
				}
			});
		});
	});
}

// --- new grain -----------------------------------------------------------------
async function newGrain() {
	const { apps } = await api("/api/apps");
	if (!apps.length) {
		openSheet(
			`${sheetHead("No apps yet")}<p class="dim">${me.user.admin ? "Install an app first, then make as many grains of it as you like." : "Ask whoever runs this Hamstr to install some apps."}</p>
			<div class="sheet-foot">${me.user.admin ? `<a class="button" href="/apps" data-link>Get apps</a>` : `<button type="button" class="button" data-close>OK</button>`}</div>`,
			"No apps",
		);
		return;
	}
	let chosen = apps[0];
	openSheet(
		`${sheetHead("New grain", "Pick an app. Each grain gets its own storage and its own sharing.")}
		<div class="choices">${apps
			.map(
				(a, i) => `<button type="button" class="choice" data-slug="${esc(a.slug)}" aria-pressed="${i === 0}">${iconTile(a)}
				<span><strong>${esc(a.name)}</strong><br><span class="dim small">${esc(a.summary)}</span></span></button>`,
			)
			.join("")}</div>
		<form id="newForm" class="gap-top">
			<div class="field"><label for="grainTitle">Name</label><input class="input" id="grainTitle" maxlength="80" placeholder="Untitled ${esc(chosen.name)}" autocomplete="off"></div>
			<div class="sheet-foot"><button type="button" class="button ghost" data-close>Cancel</button><button type="submit" class="button">Create</button></div>
		</form>`,
		"New grain",
	);
	const titleInput = sheet.querySelector("#grainTitle");
	sheet.querySelectorAll(".choice").forEach((btn) =>
		btn.addEventListener("click", () => {
			sheet.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
			chosen = apps.find((a) => a.slug === btn.dataset.slug);
			titleInput.placeholder = `Untitled ${chosen.name}`;
			titleInput.focus();
		}),
	);
	sheet.querySelector("#newForm").addEventListener("submit", async (e) => {
		e.preventDefault();
		const submit = e.target.querySelector("[type=submit]");
		submit.disabled = true;
		submit.innerHTML = `<span class="spinner"></span> Creating`;
		try {
			const { grain } = await api("/api/grains", { method: "POST", body: { slug: chosen.slug, title: titleInput.value } });
			navigate(`/g/${grain.id}`);
		} catch (err) {
			submit.disabled = false;
			submit.textContent = "Create";
			oops(err);
		}
	});
}

// --- grain view ------------------------------------------------------------------
async function grainView(id) {
	main.innerHTML = `<div class="grain-view"><div class="grain-bar"><a class="icon-button" href="/" data-link aria-label="Back">${ICON.back}</a></div><div class="grain-loading"><span class="spinner"></span></div></div>`;
	const { grain, app } = await api(`/api/grains/${id}`);
	document.title = `${grain.title} · Hamstr`;
	if (grain.trashedAt) {
		main.querySelector(".grain-loading").innerHTML = `<div class="empty"><h2>“${esc(grain.title)}” is in the trash</h2><p>Restore it to open it again.</p>
			<button type="button" class="button" data-restore>Restore</button></div>`;
		main.querySelector("[data-restore]").addEventListener("click", async () => {
			await api(`/api/grains/${id}/restore`, { method: "POST", body: {} }).catch(oops);
			grainView(id);
		});
		return;
	}
	const roleTitle = grain.isOwner ? "Owner" : ((app?.roles ?? []).find((r) => r.id === grain.role)?.title ?? (grain.role === "member" ? "Full access" : grain.role));
	main.querySelector(".grain-bar").innerHTML = `
		<a class="icon-button" href="${grain.isOwner ? "/" : "/shared"}" data-link aria-label="Back">${ICON.back}</a>
		${iconTile(grain.app)}
		<input class="grain-title" value="${esc(grain.title)}" maxlength="80" aria-label="Grain name" ${grain.isOwner ? "" : "readonly"}>
		<span class="chip ${grain.isOwner ? "accent" : ""} hide-sm">${esc(roleTitle)}</span>
		<span class="spacer"></span>
		${grain.isOwner ? `<button type="button" class="button small" data-share>${ICON.share.replace("<svg", '<svg width="16" height="16"')} Share</button>` : ""}
		<a class="icon-button" href="/g/${grain.id}/open" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">${ICON.external}</a>
		<div class="me">
			<button type="button" class="icon-button" aria-haspopup="menu" aria-expanded="false" aria-label="More">${ICON.more}</button>
			<div class="menu" role="menu" hidden>
				${grain.isOwner ? `<button type="button" class="menu-item danger" role="menuitem" data-trash>Move to trash</button>` : `<button type="button" class="menu-item" role="menuitem" data-leave>Remove from my list</button>`}
			</div>
		</div>`;
	const titleInput = main.querySelector(".grain-title");
	if (grain.isOwner) {
		const save = async () => {
			const value = titleInput.value.trim();
			if (!value || value === grain.title) return void (titleInput.value = grain.title);
			try {
				await api(`/api/grains/${id}`, { method: "PATCH", body: { title: value } });
				grain.title = value;
				document.title = `${value} · Hamstr`;
			} catch (err) {
				titleInput.value = grain.title;
				oops(err);
			}
		};
		titleInput.addEventListener("keydown", (e) => e.key === "Enter" && titleInput.blur());
		titleInput.addEventListener("blur", save);
		main.querySelector("[data-share]").addEventListener("click", () => shareSheet(grain, app).catch(oops));
		main.querySelector("[data-trash]").addEventListener("click", async () => {
			try {
				await api(`/api/grains/${id}/trash`, { method: "POST", body: {} });
				toast("Moved to the trash");
				navigate("/");
			} catch (err) {
				oops(err);
			}
		});
	} else {
		main.querySelector("[data-leave]").addEventListener("click", async () => {
			try {
				await api(`/api/grains/${id}/leave`, { method: "POST", body: {} });
				toast("Removed from your list");
				navigate("/shared");
			} catch (err) {
				oops(err);
			}
		});
	}
	const { url } = await api(`/api/grains/${id}/open`, { method: "POST", body: { path: "/" } });
	const frame = document.createElement("iframe");
	frame.className = "grain-frame";
	frame.title = grain.title;
	// A grain is another origin. No top navigation without a click, so an app
	// cannot silently replace the shell with a look-alike page.
	frame.setAttribute(
		"sandbox",
		"allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-by-user-activation",
	);
	frame.setAttribute("allow", "clipboard-write; fullscreen");
	frame.src = url;
	main.querySelector(".grain-loading").replaceWith(frame);
}

async function shareSheet(grain, app) {
	const roles = app?.roles ?? [];
	const render = async (created) => {
		const { shares } = await api(`/api/grains/${grain.id}/shares`);
		const roleTitle = (id) => roles.find((r) => r.id === id)?.title ?? (id === "member" ? "Full access" : id);
		openSheet(
			`${sheetHead(`Share “${esc(grain.title)}”`, "Anyone with a link can open this grain. Signed-in people keep it under Shared.")}
			${
				created
					? `<div class="callout"><strong>Your new link</strong> (shown once, so copy it now)
					<div class="linkbox gap-top-sm"><input class="input" readonly value="${esc(created)}" id="newLink"><button type="button" class="button small" data-copy>${ICON.copy.replace("<svg", '<svg width="16" height="16"')} Copy</button></div></div>`
					: ""
			}
			<form id="shareForm">
				${
					roles.length
						? `<div class="field"><label>What can they do?</label><div class="choices">${roles
								.map(
									(r) => `<label class="choice"><input type="radio" name="role" value="${esc(r.id)}" ${r.id === app.defaultRole ? "checked" : ""}>
									<span><strong>${esc(r.title)}</strong>${r.description ? `<br><span class="dim small">${esc(r.description)}</span>` : ""}</span></label>`,
								)
								.join("")}</div></div>`
						: `<p class="callout">${esc(app?.name ?? "This app")} doesn't define roles, so a link gives full access to this grain (everything but sharing it further).</p>`
				}
				<div class="field"><label for="shareLabel">Who is it for? <span class="dim">(optional)</span></label><input class="input" id="shareLabel" maxlength="60" placeholder="e.g. Family group chat"></div>
				<div class="sheet-foot"><button type="submit" class="button">Create link</button></div>
			</form>
			${
				shares.length
					? `<div class="section gap-top"><h3 class="gap-bottom">Active links</h3><div class="rows">${shares
							.map(
								(s) => `<div class="row" data-share="${esc(s.id)}"><div class="grow"><strong>${esc(s.label || "Untitled link")}</strong>
								<div class="dim small">${esc(roleTitle(s.role))} · ${s.people} ${s.people === 1 ? "person" : "people"} · ${timeAgo(s.createdAt)}</div></div>
								<button type="button" class="button danger small" data-revoke>Turn off</button></div>`,
							)
							.join("")}</div></div>`
					: ""
			}`,
			"Share",
		);
		sheet.querySelector("[data-copy]")?.addEventListener("click", async () => {
			const input = sheet.querySelector("#newLink");
			try {
				await navigator.clipboard.writeText(input.value);
				toast("Link copied");
			} catch {
				input.select();
				toast("Press Ctrl+C to copy");
			}
		});
		sheet.querySelector("#shareForm").addEventListener("submit", async (e) => {
			e.preventDefault();
			const role = sheet.querySelector("input[name=role]:checked")?.value;
			try {
				const result = await api(`/api/grains/${grain.id}/shares`, { method: "POST", body: { role, label: sheet.querySelector("#shareLabel").value } });
				render(result.url);
			} catch (err) {
				oops(err);
			}
		});
		sheet.querySelectorAll("[data-revoke]").forEach((btn) =>
			btn.addEventListener("click", async () => {
				try {
					await api(`/api/shares/${btn.closest("[data-share]").dataset.share}`, { method: "DELETE" });
					toast("Link turned off. Anyone using it lost access.");
					render();
				} catch (err) {
					oops(err);
				}
			}),
		);
	};
	await render();
}

// --- apps ---------------------------------------------------------------------------
async function appsPage() {
	const [{ apps }, market] = await Promise.all([api("/api/apps"), api("/api/market?limit=60").catch((err) => ({ error: err.message }))]);
	const installed = new Map(apps.map((a) => [a.slug, a]));
	main.innerHTML = `<div class="page">
		<div class="page-head"><div><h1>Apps</h1><p class="dim">${me.user.admin ? "Install apps from the store; everyone here can then make grains with them." : "Apps installed on this Hamstr. Ask an admin to add more."}</p></div></div>
		<div class="cards" id="installed">${
			apps.length
				? apps
						.map(
							(a) => `<div class="card" data-slug="${esc(a.slug)}"><div class="card-head">${iconTile(a)}<div><h3>${esc(a.name)}</h3><span class="dim small">v${esc(a.version)} · ${a.grains} grain${a.grains === 1 ? "" : "s"}</span></div></div>
							<p class="dim small">${esc(a.summary)}</p>
							<div class="card-actions"><button type="button" class="button small" data-make>New grain</button><span data-update></span>
							${me.user.admin && a.grains === 0 ? `<button type="button" class="button quiet small" data-remove>Remove</button>` : ""}</div></div>`,
						)
						.join("")
				: `<div class="empty span-all"><h2>No apps installed</h2><p>${me.user.admin ? "Pick some from the store below." : "Nothing to make grains with yet."}</p></div>`
		}</div>
		<div class="section"><div class="page-head compact"><h2>From the store</h2><input class="input search" type="search" placeholder="Search apps" id="search" aria-label="Search the store"></div>
		<div class="cards" id="market"></div></div>
	</div>`;
	const renderMarket = (result) => {
		const box = main.querySelector("#market");
		if (!box) return;
		if (result.error) return void (box.innerHTML = `<p class="error">${esc(result.error)}</p>`);
		const items = result.apps ?? [];
		box.innerHTML = items.length
			? items
					.map((a) => {
						const here = installed.get(a.slug);
						return `<div class="card" data-slug="${esc(a.slug)}"><div class="card-head">${iconTile(a)}<div><h3>${esc(a.name)}</h3><span class="dim small">${esc(a.publisher ?? "")}${a.version ? ` · v${esc(a.version)}` : ""}</span></div></div>
						<p class="dim small">${esc(a.summary)}</p>
						<div class="card-actions">${here ? `<span class="chip">Installed</span>` : me.user.admin ? `<button type="button" class="button ghost small" data-install>Install</button>` : ""}</div></div>`;
					})
					.join("")
			: `<p class="dim">No apps match.</p>`;
		box.querySelectorAll("[data-install]").forEach((b) => b.addEventListener("click", () => installSheet(b.closest("[data-slug]").dataset.slug).catch(oops)));
	};
	renderMarket(market);
	let timer;
	main.querySelector("#search").addEventListener("input", (e) => {
		clearTimeout(timer);
		timer = setTimeout(async () => renderMarket(await api(`/api/market?limit=60&q=${encodeURIComponent(e.target.value.trim())}`).catch((err) => ({ error: err.message }))), 250);
	});
	main.querySelectorAll("#installed [data-slug]").forEach((card) => {
		const slug = card.dataset.slug;
		card.querySelector("[data-make]").addEventListener("click", async () => {
			try {
				const app = installed.get(slug);
				const { grain } = await api("/api/grains", { method: "POST", body: { slug, title: `Untitled ${app.name}` } });
				navigate(`/g/${grain.id}`);
			} catch (err) {
				oops(err);
			}
		});
		card.querySelector("[data-remove]")?.addEventListener("click", async () => {
			try {
				await api(`/api/apps/${slug}`, { method: "DELETE" });
				toast("Removed");
				appsPage();
			} catch (err) {
				oops(err);
			}
		});
	});
	if (me.user.admin && apps.length) {
		api("/api/apps/updates")
			.then(({ updates }) => {
				for (const [slug, info] of Object.entries(updates)) {
					const slot = main.querySelector(`#installed [data-slug="${CSS.escape(slug)}"] [data-update]`);
					if (!slot) continue;
					slot.innerHTML = `<button type="button" class="button ghost small">Update to v${esc(info.version)}</button>`;
					slot.querySelector("button").addEventListener("click", () => installSheet(slug, true).catch(oops));
				}
			})
			.catch(() => {});
	}
}

async function installSheet(slug, update = false) {
	const { app, releases } = await api(`/api/market/${encodeURIComponent(slug)}`);
	const release = (releases ?? []).find((r) => r.status === "published");
	if (!release) throw new Error("That app has no published release.");
	const m = release.manifest ?? {};
	const egress = m.egress ?? [];
	const roles = m.roles ?? [];
	openSheet(
		`${sheetHead(`${update ? "Update" : "Install"} ${esc(app.name)}`, `v${esc(release.version)}`)}
		<div class="card-head gap-bottom">${iconTile(app)}<p class="dim flush">${esc(app.summary)}</p></div>
		<div class="callout"><strong>What it can do</strong><ul class="perm-list">
			<li>Store data inside each grain, separately per grain</li>
			${egress.length ? `<li><strong>Connect to the internet:</strong> ${egress.map(esc).join(", ")}</li>` : "<li>No internet access</li>"}
			${roles.length ? `<li>Sharing roles: ${roles.map((r) => esc(r.title)).join(", ")}</li>` : "<li>No sharing roles: links give full access</li>"}
		</ul></div>
		${update ? `<p class="dim small">Every grain of this app moves to the new version. Their data stays.</p>` : ""}
		<div class="sheet-foot"><button type="button" class="button ghost" data-close>Cancel</button>
		<button type="button" class="button" data-go>${egress.length ? `Allow network and ${update ? "update" : "install"}` : update ? "Update" : "Install"}</button></div>`,
		"Install app",
	);
	sheet.querySelector("[data-go]").addEventListener("click", async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true;
		btn.innerHTML = `<span class="spinner"></span> ${update ? "Updating" : "Installing"}…`;
		try {
			const result = await api("/api/apps", { method: "POST", body: { slug, version: release.version, allowEgress: egress.length > 0 } });
			closeSheet();
			toast(result.failedGrains?.length ? `${app.name} updated, but ${result.failedGrains.length} grain(s) failed to move` : `${app.name} is ready`, Boolean(result.failedGrains?.length));
			appsPage();
		} catch (err) {
			btn.disabled = false;
			btn.textContent = update ? "Update" : "Install";
			oops(err);
		}
	});
}

// --- boot ------------------------------------------------------------------------------
(async () => {
	try {
		me = await api("/api/me");
	} catch (err) {
		if (err.status === 401) return;
		main.innerHTML = `<div class="welcome"><div class="welcome-card"><h1>Hamstr is not answering</h1><p class="dim">${esc(err.message)}</p></div></div>`;
		return;
	}
	const initials = (me.user.name ?? "?")
		.split(/\s+/)
		.map((p) => p[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
	document.getElementById("avatar").textContent = initials;
	document.getElementById("avatar").setAttribute("aria-label", `Account: ${me.user.name}`);
	document.getElementById("meName").textContent = me.user.name;
	document.getElementById("meEmail").textContent = me.user.email ?? "";
	route();
})();
