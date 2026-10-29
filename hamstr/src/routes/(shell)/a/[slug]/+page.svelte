<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { appMenu, downloadItem as download, grainAction, grainMenu } from "#lib/client/actions.js";
	import { askUninstall, contextMenu, oops, toast } from "#lib/client/ui.svelte.js";
	import { ICON, sized } from "#lib/icons.js";
	import { shortDate, timeAgo } from "#lib/format.js";
	import Modal from "#lib/components/Modal.svelte";
	import MoreMenu from "#lib/components/MoreMenu.svelte";
	import TileIcon from "#lib/components/TileIcon.svelte";

	let { data } = $props();

	const app = $derived(data.app);
	const TABS = ["mine", "trash"];
	const tab = $derived(TABS.includes(page.url.searchParams.get("tab")) ? page.url.searchParams.get("tab") : "mine");

	// View and sort are remembered per browser; the search is per visit.
	let view = $state("grid");
	let sort = $state("opened");
	let query = $state("");
	let search = $state(null);
	onMount(() => {
		view = localStorage.getItem("hamstr:view") === "list" ? "list" : "grid";
		sort = ["opened", "created", "name"].includes(localStorage.getItem("hamstr:sort")) ? localStorage.getItem("hamstr:sort") : "opened";
	});
	function setView(value) {
		view = value;
		localStorage.setItem("hamstr:view", value);
	}
	function setSort(event) {
		sort = event.currentTarget.value;
		localStorage.setItem("hamstr:sort", sort);
	}

	const source = $derived(tab === "trash" ? data.trash : data.mine);
	const items = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = q ? source.filter((g) => g.title.toLowerCase().includes(q)) : [...source];
		if (sort === "name") list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
		else if (sort === "created") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		else list.sort((a, b) => (b.openedAt ?? b.createdAt).localeCompare(a.openedAt ?? a.createdAt));
		return list;
	});

	// --- actions ---------------------------------------------------------------------
	let creating = $state(false);
	async function create() {
		if (creating) return;
		creating = true;
		try {
			const { grain } = await api("/api/grains", { method: "POST", body: { slug: app.slug } });
			await goto(`/g/${grain.id}`);
		} catch (err) {
			oops(err);
		} finally {
			creating = false;
		}
	}

	let renaming = $state(null);
	let newTitle = $state("");
	function startRename(grain) {
		renaming = grain;
		newTitle = grain.title;
	}
	async function rename(event) {
		event.preventDefault();
		const title = newTitle.trim();
		if (!title || title === renaming.title) return void (renaming = null);
		try {
			await api(`/api/grains/${renaming.id}`, { method: "PATCH", body: { title } });
			renaming = null;
			await invalidateAll();
		} catch (err) {
			oops(err);
		}
	}


	let confirming = $state(null);
	let deleting = $state(false);
	async function remove() {
		deleting = true;
		try {
			await api(`/api/grains/${confirming.id}`, { method: "DELETE" });
			confirming = null;
			toast("Deleted for good");
			await invalidateAll();
		} catch (err) {
			oops(err);
		} finally {
			deleting = false;
		}
	}

	function menuFor(grain) {
		if (tab === "trash") {
			return [
				{ label: "Restore", icon: "restore", onclick: () => grainAction(grain, "restore", "Restored") },
				{ label: "Delete forever…", icon: "trash", danger: true, separator: true, onclick: () => (confirming = grain) },
			];
		}
		return grainMenu(grain, { canExport: app.canExport, rename: startRename });
	}

	// The app itself: a right click on the hero, or its ⋯ button.
	const heroMenu = $derived(appMenu(app, { admin: data.admin, here: "app" }).slice(2));

	const subtitle = (grain) =>
		tab === "trash"
			? `Trashed ${timeAgo(grain.trashedAt)}`
			: grain.openedAt
				? `Opened ${timeAgo(grain.openedAt)}`
				: `Created ${timeAgo(grain.createdAt)}`;

	// "/" searches, "n" makes a new one, like a desktop app.
	function onkeydown(event) {
		if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea, select, [contenteditable]") || document.querySelector(".scrim")) return;
		if (event.key === "/") {
			event.preventDefault();
			search?.focus();
		} else if (event.key === "n" && tab === "mine") {
			event.preventDefault();
			create();
		}
	}

	let about = $state(false);
</script>

<svelte:window {onkeydown} />
<svelte:head><title>{app ? `${app.name} · ${page.data.name}` : page.data.name}</title></svelte:head>

{#if data.missing}
	<div class="page">
		<div class="empty">
			<h2>That app is not installed</h2>
			<p><a class="button" href="/">Home</a></p>
		</div>
	</div>
{:else if !data.signedOut}
	<div class="page">
		<nav class="crumbs" aria-label="Breadcrumb">
			<a href="/">Home</a>{@html ICON.chevron}<span aria-current="page">{app.name}</span>
		</nav>

		<header class="hero" use:contextMenu={() => appMenu(app, { admin: data.admin, here: "app" })}>
			<TileIcon {app} extra="big" />
			<div class="hero-text">
				<h1>{app.name}</h1>
				<p class="dim">{app.summary}</p>
				<div class="chips">
					<span class="chip">v{app.version}</span>
					<span class="chip">{data.mine.length} {data.mine.length === 1 ? "item" : "items"}</span>
					{#if app.egress.length}<span class="chip warn" title="Can connect to: {app.egress.join(", ")}">Uses the internet</span>{:else}<span class="chip" title="Can't connect to anything outside this Hamstr; its data never leaves it">Doesn't use the internet</span>{/if}
					{#if app.canExport}<span class="chip">Exports data</span>{/if}
				</div>
			</div>
			<div class="hero-actions">
				<button type="button" class="button" disabled={creating} onclick={create} title="New (N)">
					{#if creating}<span class="spinner"></span> Creating{:else}{@html sized("plus")} New{/if}
				</button>
				<button type="button" class="button ghost" onclick={() => (about = true)}>{@html sized("info")} About</button>
				<MoreMenu items={heroMenu} label="More for {app.name}" />
			</div>
		</header>

		<div class="toolbar">
			<div class="segmented" role="tablist" aria-label="Show">
				<a role="tab" href="?" data-sveltekit-replacestate data-sveltekit-noscroll aria-selected={tab === "mine"}>Yours <span class="count">{data.mine.length}</span></a>
				<a role="tab" href="?tab=trash" data-sveltekit-replacestate data-sveltekit-noscroll aria-selected={tab === "trash"}>Trash <span class="count">{data.trash.length}</span></a>
			</div>
			<span class="spacer"></span>
			<label class="search-box">
				{@html ICON.search}
				<input bind:this={search} bind:value={query} type="search" placeholder="Search" aria-label="Search {app.name}" />
				<kbd class="hide-sm">/</kbd>
			</label>
			<select class="input select" aria-label="Sort by" value={sort} onchange={setSort}>
				<option value="opened">Last opened</option>
				<option value="created">Newest</option>
				<option value="name">Name</option>
			</select>
			<div class="segmented icons" role="group" aria-label="View">
				<button type="button" aria-pressed={view === "grid"} aria-label="Icons" title="Icons" onclick={() => setView("grid")}>{@html ICON.grid}</button>
				<button type="button" aria-pressed={view === "list"} aria-label="List" title="List" onclick={() => setView("list")}>{@html ICON.list}</button>
			</div>
		</div>

		{#if !items.length}
			<div class="empty">
				{#if query}
					<h2>Nothing matches “{query}”</h2>
					<p><button type="button" class="button ghost" onclick={() => (query = "")}>Clear search</button></p>
				{:else if tab === "trash"}
					<h2>The trash is empty</h2>
					<p>Things you trash stay here for 30 days, then they are deleted for good.</p>
				{:else}
					<TileIcon {app} extra="big ghosted" />
					<h2>No {app.name} yet</h2>
					<p>Each one keeps its own data, apart from every other one.</p>
					<p><button type="button" class="button" onclick={create}>{@html sized("plus")} Make your first</button></p>
				{/if}
			</div>
		{:else if view === "grid"}
			<div class="tiles">
				{#if tab === "mine" && !query}
					<button type="button" class="tile new" disabled={creating} onclick={create}>
						<span class="plus">+</span><span class="tile-title">New</span>
					</button>
				{/if}
				{#each items as grain (grain.id)}
					<div class="tile-wrap" use:contextMenu={() => menuFor(grain)}>
						{#if tab === "trash"}
							<div class="tile trashed">
								<TileIcon app={grain.app} />
								<span class="tile-title">{grain.title}</span>
								<span class="tile-meta">{subtitle(grain)}</span>
							</div>
						{:else}
							<a class="tile" href="/g/{grain.id}" title={grain.title}>
								<TileIcon app={grain.app} />
								<span class="tile-title">{grain.title}</span>
								<span class="tile-meta">{subtitle(grain)}</span>
							</a>
						{/if}
						<MoreMenu items={menuFor(grain)} label="Actions for {grain.title}" extra="tile-more" />
					</div>
				{/each}
			</div>
		{:else}
			<div class="rows list">
				<div class="row head dim tiny" aria-hidden="true">
					<span class="icon-col"></span>
					<span class="grow">Name</span>
					<span class="col hide-sm">Created</span>
					<span class="col hide-sm">{tab === "trash" ? "Trashed" : "Last opened"}</span>
					<span class="actions-col"></span>
				</div>
				{#each items as grain (grain.id)}
					<div class="row" data-id={grain.id} use:contextMenu={() => menuFor(grain)}>
						<TileIcon app={grain.app} />
						<div class="grow">
							{#if tab === "trash"}
								<strong>{grain.title}</strong>
							{:else}
								<a class="row-link" href="/g/{grain.id}">{grain.title}</a>
							{/if}
							<div class="dim small show-sm">{subtitle(grain)}</div>
						</div>
						<span class="col dim small hide-sm">{shortDate(grain.createdAt)}</span>
						<span class="col dim small hide-sm">{tab === "trash" ? timeAgo(grain.trashedAt) : grain.openedAt ? timeAgo(grain.openedAt) : "Never"}</span>
						<span class="actions-col">
							{#if tab === "trash"}
								<button type="button" class="icon-button" title="Restore" aria-label="Restore {grain.title}" onclick={() => grainAction(grain, "restore", "Restored")}>{@html ICON.restore}</button>
							{:else if tab === "mine" && app.canExport}
								<button type="button" class="icon-button hide-sm" title="Download data" aria-label="Download data of {grain.title}" onclick={() => download(grain)}>{@html ICON.download}</button>
							{/if}
							<MoreMenu items={menuFor(grain)} label="Actions for {grain.title}" />
						</span>
					</div>
				{/each}
			</div>
		{/if}
		{#if tab === "trash" && items.length}
			<p class="dim small hint">Things in the trash are deleted for good 30 days after you trash them. Nobody can open them meanwhile.</p>
		{/if}
	</div>
{/if}

{#if renaming}
	<Modal title="Rename" onclose={() => (renaming = null)}>
		<form onsubmit={rename}>
			<div class="field">
				<label for="renameTitle">Name</label>
				<input class="input" id="renameTitle" maxlength="80" autocomplete="off" bind:value={newTitle} autofocus />
			</div>
			<div class="sheet-foot">
				<button type="button" class="button ghost" onclick={() => (renaming = null)}>Cancel</button>
				<button type="submit" class="button">Save</button>
			</div>
		</form>
	</Modal>
{/if}

{#if confirming}
	<Modal title="Delete forever?" onclose={() => (confirming = null)}>
		<p>“{confirming.title}” and all of its data will be erased. This can't be undone.</p>
		{#if app.canExport}<p class="dim small">Restore it first if you want to download its data.</p>{/if}
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={() => (confirming = null)}>Keep it</button>
			<button type="button" class="button danger-solid" disabled={deleting} onclick={remove}>Delete forever</button>
		</div>
	</Modal>
{/if}

{#if about}
	<Modal title="About {app.name}" sub="Version {app.version}{app.license ? ` · ${app.license}` : ''}" onclose={() => (about = false)}>
		<div class="card-head gap-bottom">
			<TileIcon {app} />
			<p class="flush">{app.summary}</p>
		</div>
		{#if app.description}
			{#each app.description.split(/\n{2,}/) as para, i (i)}<p class="dim small">{para}</p>{/each}
		{/if}
		<div class="callout">
			<strong>What it can do</strong>
			<ul class="perm-list">
				<li>Keep data inside each item, separately per item</li>
				{#if app.egress.length}<li><strong>Connect to the internet:</strong> {app.egress.join(", ")}</li>{:else}<li>No internet access</li>{/if}
				<li>{app.canExport ? "Download each item's data" : "No data download yet"}</li>
				<li>{app.instances === "single" ? "One per person, opened straight from Home" : "As many as you like"}</li>
			</ul>
		</div>
		<dl class="facts small">
			<dt>Installed</dt><dd>{shortDate(app.installedAt)}</dd>
			<dt>Updated</dt><dd>{shortDate(app.updatedAt)}</dd>
			{#if app.homepage}<dt>Website</dt><dd><a href={app.homepage} target="_blank" rel="noopener noreferrer">{app.homepage}</a></dd>{/if}
			{#if app.source}<dt>Source</dt><dd><a href={app.source} target="_blank" rel="noopener noreferrer">{app.source}</a></dd>{/if}
		</dl>
		<div class="sheet-foot">
			{#if data.admin}<button type="button" class="button quiet danger-text push-left" onclick={() => ((about = false), askUninstall(app))}>Uninstall…</button>{/if}
			<a class="button ghost" href="/store/{app.slug}">View in Store</a>
			<button type="button" class="button" onclick={() => (about = false)}>Done</button>
		</div>
	</Modal>
{/if}
